# sam-ui (Apache-2.0). New file, not from SAM 2.
import torch

from tracks.features import VIDEO_KEY, FeatureCache, install

MB = 1 << 20


class Backbone:
    """SAM 2's _get_image_feature surface: one cached frame per state, a
    backbone call on every miss (counted)."""

    def __init__(self):
        self.calls = 0

    def _get_image_feature(self, inference_state, frame_idx, batch_size):
        image, out = inference_state["cached_features"].get(frame_idx, (None, None))
        if out is None:
            self.calls += 1
            f = float(frame_idx)
            out = {"backbone_fpn": [torch.full((1, 4, 8, 8), f), torch.full((1, 8, 4, 4), f + 0.5)],
                   "vision_pos_enc": [torch.ones(1, 4, 8, 8), torch.ones(1, 8, 4, 4)]}
            image = inference_state["images"][frame_idx][None]
            inference_state["cached_features"] = {frame_idx: (image, out)}
        return image, out


def state(video="v1"):
    s = {"images": torch.zeros(10, 3, 2, 2), "device": "cpu", "cached_features": {}}
    if video:
        s[VIDEO_KEY] = video
    return s


def test_a_second_state_on_the_same_video_skips_the_backbone():
    p, c = Backbone(), FeatureCache(64 * MB)
    install(p, c)
    for f in range(5):
        p._get_image_feature(state(), f, 1)
    assert p.calls == 5
    s2 = state()
    for f in range(5):
        _, out = p._get_image_feature(s2, f, 2)
        assert torch.equal(out["backbone_fpn"][0], torch.full((1, 4, 8, 8), float(f)))
    assert p.calls == 5 and c.hits == 5


def test_other_videos_and_unkeyed_states_are_not_mixed_up():
    p, c = Backbone(), FeatureCache(64 * MB)
    install(p, c)
    p._get_image_feature(state("v1"), 0, 1)
    p._get_image_feature(state("v2"), 0, 1)  # another video: its own entry
    p._get_image_feature(state(None), 0, 1)  # no key: upstream behaviour, not cached
    p._get_image_feature(state(None), 0, 1)
    assert p.calls == 4 and len(c) == 2


def test_least_recently_used_frames_go_first_and_the_budget_holds():
    p = Backbone()
    frame_bytes = (4 * 8 * 8 + 8 * 4 * 4) * 4
    c = FeatureCache(3 * frame_bytes)
    install(p, c)
    for f in range(3):
        p._get_image_feature(state(), f, 1)
    p._get_image_feature(state(), 0, 1)  # touch frame 0
    p._get_image_feature(state(), 3, 1)  # evicts frame 1, the oldest untouched
    assert c.has("v1", 0) and not c.has("v1", 1) and c.has("v1", 3)
    assert c.nbytes <= 3 * frame_bytes


def test_pos_enc_is_kept_once_per_video_and_dropped_with_its_last_frame():
    p = Backbone()
    frame_bytes = (4 * 8 * 8 + 8 * 4 * 4) * 4
    c = FeatureCache(frame_bytes)
    install(p, c)
    p._get_image_feature(state("v1"), 0, 1)
    p._get_image_feature(state("v2"), 0, 1)  # evicts v1's only frame
    assert not c.has("v1", 0) and "v1" not in c._pos and "v2" in c._pos


def test_installing_twice_swaps_the_cache_without_double_wrapping():
    p = Backbone()
    install(p, FeatureCache(64 * MB))
    c2 = FeatureCache(64 * MB)
    install(p, c2)
    p._get_image_feature(state(), 0, 1)
    assert len(c2) == 1
