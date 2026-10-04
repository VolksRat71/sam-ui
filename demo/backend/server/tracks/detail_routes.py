"""Opt-in detail endpoints; session resolution owns every source path."""
from flask import jsonify, request
from av.error import FFmpegError
from tracks.detail import DetailError, enabled
from tracks.service import UnknownEngine, ObjectBusy
from tracks.detail_preview import DetailPreviews


def register_detail_routes(bp, resolve):
    def respond(operation):
        try:
            if not enabled(): raise DetailError('refine_detail_disabled')
            body = request.get_json(silent=True)
            if not isinstance(body, dict): raise DetailError('invalid_body')
            if not isinstance(body.get('session_id'), str): raise DetailError('invalid_session')
            ctx = resolve(body['session_id'])
            with ctx.lock, ctx.autocast():
                if not hasattr(ctx.service, '_detail_previews'):
                    ctx.service._detail_previews = DetailPreviews(ctx.service)
                return jsonify(operation(ctx, body, ctx.service._detail_previews))
        except DetailError as exc:
            return jsonify(error=str(exc)), 400
        except UnknownEngine:
            return jsonify(error='invalid_engine'), 400
        except ObjectBusy:
            return jsonify(error='detail_object_busy'), 409
        except FFmpegError:
            return jsonify(error='detail_media_unavailable'), 400
        except (ValueError, KeyError, IndexError, TypeError):
            return jsonify(error='invalid_detail_request'), 400
        except OSError:
            return jsonify(error='detail_media_unavailable'), 400

    def target(ctx, body):
        name = body.get('engine') or ctx.service.default
        if not isinstance(name, str): raise DetailError('invalid_engine')
        engine = ctx.service._engine_model(name)[0]
        return dict(video=ctx.video, path=ctx.path, owner=body['session_id'],
                    obj_id=body['object_id'], frame=body['frame_index'], engine=engine)

    @bp.route('/detail_state', methods=['POST'])
    def detail_state():
        if not enabled(): return jsonify(enabled=False, objects={})
        return respond(lambda c, b, p: dict(enabled=True, objects={str(o): c.service.seeds.details(c.video, o) for o in c.service.seeds.objects(c.video)}))

    @bp.route('/detail_frame', methods=['POST'])
    def detail_frame():
        return respond(lambda c, b, p: p.frame(**target(c, b)))

    @bp.route('/preview_detail_crop', methods=['POST'])
    def preview_detail_crop():
        return respond(lambda c, b, p: p.preview(**target(c, b), revision=b['correction_revision'],
            rect=b['crop_rect'], points=b['crop_points'], request_id=b['request_id']))

    @bp.route('/apply_detail_crop', methods=['POST'])
    def apply_detail_crop():
        return respond(lambda c, b, p: p.apply(b['preview_id'], b['expected_correction_revision'], owner=b['session_id']))

    @bp.route('/remove_detail_crop', methods=['POST'])
    def remove_detail_crop():
        def remove(c, b, p):
            t = target(c, b)
            return p.remove(video=c.video, obj_id=t['obj_id'], frame=t['frame'],
                detail_id=b['detail_id'], expected_revision=b['expected_correction_revision'])
        return respond(remove)
