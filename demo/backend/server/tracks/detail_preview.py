"""Session-owned, bounded crop previews. Apply never accepts a client mask."""
from collections import OrderedDict
import base64
import hashlib
import io
import time
import uuid
from threading import RLock

import numpy as np
from PIL import Image

from data.assets.timing import canonical_json
from tracks import rle
from tracks.detail import DetailError, enabled, effective_mask, validate_detail
from tracks.ranges import absent_at


def read_working_frame(path, index):
    from tracks.streaming import _PyAVRuns
    return _PyAVRuns(path, run=1).get(index).numpy().copy()


class DetailPreviews:
    def __init__(self, service, *, read_frame=read_working_frame, infer=None,
                 clock=time.monotonic, ttl=300, max_previews=16):
        self.service, self.read_frame, self.infer = service, read_frame, infer
        self.clock, self.ttl, self.max_previews = clock, ttl, max_previews
        self.previews = OrderedDict()
        self.lock = RLock()

    def _target(self, video, obj_id, frame):
        if not enabled(): raise DetailError('refine_detail_disabled')
        if type(obj_id) is not int or type(frame) is not int or frame < 0:
            raise DetailError('invalid_detail_target')
        if obj_id not in self.service.seeds.objects(video): raise DetailError('detail_object_missing')
        self.service._check_free(video, obj_id)
        return self.service._record(video, obj_id)[0]

    def _base(self, video, obj_id, frame, engine):
        self._target(video, obj_id, frame)
        if absent_at(self.service.seeds.ranges(video, obj_id), frame): raise DetailError('detail_frame_absent')
        base = self.service.tracks.mask_at(video, obj_id, engine, frame)
        if base is None:
            base = self.service.seeds.seeds(video, obj_id).get(frame, {}).get('mask')
        if base is None or rle.area(base) == 0: raise DetailError('detail_base_unavailable')
        revision = hashlib.sha256(canonical_json(dict(video=video, object_id=obj_id, frame=frame,
            engine=engine, snapshot=self.service._record(video, obj_id)[0], base=base))).hexdigest()
        return base, revision

    def frame(self, *, video, path, owner, obj_id, frame, engine):
        with self.lock:
            snapshot = self._target(video, obj_id, frame)
            try:
                base, revision = self._base(video, obj_id, frame, engine)
            except ValueError as exc:
                if str(exc) not in ('detail_frame_absent', 'detail_base_unavailable'): raise
                return dict(revision=None, snapshot_revision=snapshot, base=None,
                    details=self.service.seeds.details(video, obj_id).get(frame, []), unavailable=str(exc))
            pixels = self.read_frame(path, frame)
            if list(pixels.shape[:2]) != list(base['size']): raise DetailError('detail_base_geometry_mismatch')
            image = io.BytesIO(); Image.fromarray(pixels).save(image, format='PNG')
            return dict(revision=revision, snapshot_revision=snapshot, width=pixels.shape[1], height=pixels.shape[0],
                image='data:image/png;base64,' + base64.b64encode(image.getvalue()).decode(), base=base,
                combined=self.service.effective_mask(video, obj_id, frame, base),
                details=self.service.seeds.details(video, obj_id).get(frame, []),
                geometry=dict(version='working-copy-v1', width=pixels.shape[1], height=pixels.shape[0]),
                source='Working copy', model='SAM 2.1 detail pass')

    def remove(self, *, video, obj_id, frame, detail_id, expected_revision):
        from tracks.versions import is_key
        with self.lock:
            snapshot = self._target(video, obj_id, frame)
            if not is_key(detail_id): raise DetailError('invalid_detail_id')
            if expected_revision != snapshot: raise DetailError('stale_preview')
            if not any(d['id'] == detail_id for d in self.service.seeds.details(video, obj_id).get(frame, [])):
                raise DetailError('detail_missing')
            with self.service._seed_change(video, obj_id):
                self.service.seeds.remove_detail(video, obj_id, frame, detail_id)
            return dict(removed=True, snapshot_revision=self.service._record(video, obj_id)[0])

    def _infer(self, pixels, points):
        if self.infer is not None: return self.infer(pixels, points)
        import torch
        from sam2.sam2_image_predictor import SAM2ImagePredictor
        engine = self.service.get_engine('sam2')
        predictor = SAM2ImagePredictor(engine.predictor)
        with torch.inference_mode():
            predictor.set_image(pixels)
            coords = np.array([[p[0] * (pixels.shape[1] - 1), p[1] * (pixels.shape[0] - 1)] for p in points])
            masks, scores, _ = predictor.predict(point_coords=coords,
                point_labels=np.array([p[2] for p in points]), multimask_output=True)
        return masks[int(np.argmax(scores))].astype(bool)

    def preview(self, *, video, path, owner, obj_id, frame, engine, revision, rect, points, request_id):
        with self.lock:
            base, current = self._base(video, obj_id, frame, engine)
            if revision != current: raise DetailError('stale_preview')
            if not isinstance(request_id, str) or not 1 <= len(request_id) <= 128:
                raise DetailError('invalid_request_id')
            # Bounds/points are validated before decoding or model execution.
            if not isinstance(rect, list) or len(rect) != 4 or any(type(v) is not int for v in rect):
                raise DetailError('invalid_detail_rect')
            w, h = rect[2] - rect[0], rect[3] - rect[1]
            if not 1 <= w <= 256 or not 1 <= h <= 256: raise DetailError('invalid_detail_rect')
            geometry = dict(version='working-copy-v1', width=base['size'][1], height=base['size'][0])
            identity = hashlib.sha256(uuid.uuid4().bytes).hexdigest()
            record = validate_detail(dict(id=identity, rect=rect, points=points,
                geometry=geometry, mask=rle.encode(np.zeros((h, w), bool))))
            for key in list(self.previews):
                if self.clock() - self.previews[key]['at'] > self.ttl: del self.previews[key]
            request_hash = hashlib.sha256(canonical_json([video, obj_id, frame, engine, revision, rect, points])).hexdigest()
            for hit in self.previews.values():
                if hit['owner'] == owner and hit['request_id'] == request_id:
                    if hit['request_hash'] != request_hash: raise DetailError('request_id_conflict')
                    return hit['response']
            pixels = self.read_frame(path, frame)
            if list(pixels.shape[:2]) != list(base['size']): raise DetailError('detail_base_geometry_mismatch')
            x0, y0, x1, y1 = rect
            mask = np.asarray(self._infer(pixels[y0:y1, x0:x1].copy(), points), dtype=bool)
            if mask.shape != (h, w): raise DetailError('detail_result_geometry_mismatch')
            record['mask'] = rle.encode(mask)
            old = rle.decode(self.service.effective_mask(video, obj_id, frame, base))
            added = int(np.count_nonzero(mask & ~old[y0:y1, x0:x1]))
            response = dict(preview_id=identity, revision=current, mask=record['mask'], rect=rect, added_pixels=added,
                combined=effective_mask(rle.encode(old), [record]), model='SAM 2.1 detail pass',
                checkpoint=self.service._engine_model('sam2')[1] if self.infer is None else 'test-double', source='Working copy')
            self.previews[identity] = dict(at=self.clock(), owner=owner, video=video, obj_id=obj_id, frame=frame,
                engine=engine, record=record, revision=current, request_id=request_id, request_hash=request_hash,
                response=response, applied=None)
            while len(self.previews) > self.max_previews: self.previews.popitem(last=False)
            return response

    def apply(self, preview_id, expected_correction_revision, *, owner):
        with self.lock:
            if not enabled(): raise DetailError('refine_detail_disabled')
            hit = self.previews.get(preview_id)
            if hit is None or self.clock() - hit['at'] > self.ttl: raise DetailError('preview_expired')
            if hit['owner'] != owner: raise DetailError('preview_owner')
            if hit['revision'] != expected_correction_revision: raise DetailError('stale_preview')
            s, v, o, f = self.service, hit['video'], hit['obj_id'], hit['frame']
            _, current = self._base(v, o, f, hit['engine'])
            if hit['applied'] is not None:
                if current != hit['applied']['revision']: raise DetailError('stale_preview')
                return hit['applied']
            if current != hit['revision']: raise DetailError('stale_preview')
            if hit['response']['added_pixels'] == 0: raise DetailError('no_detail_added')
            with s._seed_change(v, o): s.seeds.add_detail(v, o, f, hit['record'])
            _, revision = self._base(v, o, f, hit['engine'])
            result = dict(revision=revision, detail_id=preview_id, object_id=o, frame_index=f)
            hit['applied'] = result
            return result
