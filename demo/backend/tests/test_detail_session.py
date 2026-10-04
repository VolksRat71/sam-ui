"""Detail edits across the real session API, with a model stub."""
from test_inference_api import click, start, world  # noqa: F401
from test_detail_records import detail


def test_move_clicks_drops_only_source_frame_details_and_groups_undo(world):
    make, _, path = world
    api = make(); sid = start(api, path)
    click(api, sid, 1, 0, [[.5, .5]], [1])
    click(api, sid, 1, 3, [[.8, .8]], [1])
    click(api, sid, 2, 3, [[.2, .2]], [1])
    video = api.session_states[sid]['video']; service = api.tracks
    for obj, frame, key in ((1, 0, 'a'), (1, 3, 'b'), (2, 3, 'c')):
        with service._seed_change(video, obj): service.seeds.add_detail(video, obj, frame, detail(key))
    before = {o: len(service.versions.history(video, o)['undo']) for o in (1, 2)}
    api.move_clicks(sid, 3, 1, 2)
    assert service.seeds.details(video, 1) == {0: [detail('a')]}
    assert service.seeds.details(video, 2) == {3: [detail('c')]}
    assert all(len(service.versions.history(video, o)['undo']) == before[o] + 1 for o in (1, 2))
    api.undo_seeds(sid, 1)
    assert service.seeds.details(video, 1)[3] == [detail('b')]


def test_detail_undo_redo_does_not_reseed_the_interactive_predictor(world, monkeypatch):
    make, stub, path = world
    api = make(); sid = start(api, path)
    click(api, sid, 1, 0, [[.5, .5]], [1])
    video = api.session_states[sid]['video']
    with api.tracks._seed_change(video, 1): api.tracks.seeds.add_detail(video, 1, 0, detail())
    def forbidden(*args, **kwargs): raise AssertionError('detail undo changed SAM prompts')
    monkeypatch.setattr(stub, 'add_new_mask', forbidden)
    monkeypatch.setattr(stub, 'clear_all_prompts_in_frame', forbidden)
    api.undo_seeds(sid, 1); api.redo_seeds(sid, 1)
    assert api.tracks.seeds.details(video, 1)[0] == [detail()]
