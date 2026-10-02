from fractions import Fraction
from types import SimpleNamespace
import pytest
from asset_media_fixtures import make_clip, probe, frame_ids


def api():
    from data.assets import timing
    return timing


def rows(stamps):
    return [dict(index=i, pts=None if p is None else {'num': p, 'den': 1000},
                 duration=None, duration_source=None) for i, p in enumerate(stamps)]


def test_exact_vfr():
    t = api()
    t.validate_rows(rows([1000, 1033, 1075, 1100]))
    assert t.rational(Fraction(2002, 60000)) == {'num': 1001, 'den': 30000}
    assert t.canonical_json({'b': 2, 'a': 1}) == b'{"a":1,"b":2}'


@pytest.mark.parametrize('stamps', [[1, 1], [2, 1], [None, 2]])
def test_invalid_pts(stamps):
    with pytest.raises(ValueError):
        api().validate_rows(rows(stamps))


@pytest.mark.parametrize('base,stamps,bframes', [
    (Fraction(1, 24), list(range(8)), False),
    (Fraction(1, 30), list(range(8)), False),
    (Fraction(1, 60), list(range(8)), False),
    (Fraction(1001, 30000), list(range(8)), False),
    (Fraction(1, 1000), [1000, 1033, 1075, 1100], False),
    (Fraction(1, 24), list(range(8)), True),
])
def test_real_presentation_frames(tmp_path, base, stamps, bframes):
    t = api()
    path = make_clip(tmp_path / 'source.mp4', pts=stamps, time_base=base, bframes=bframes)
    independent = probe(path)
    stream = independent['streams'][0]
    expected = [Fraction(f['pts']) * Fraction(stream['time_base'])
                for f in independent['frames'] if f['media_type'] == 'video']
    assert expected == [p * base for p in stamps], 'fixture was retimed'
    result = t.inspect_source(path)
    assert result['timing_status'] == 'valid'
    assert result['decoded_count'] == len(stamps)
    assert [Fraction(r['pts']['num'], r['pts']['den']) for r in result['frames']] == expected
    assert frame_ids(path) == list(range(len(stamps)))
    assert result['coded_width'] == 128 and result['coded_height'] == 64
    assert t.canonical_json(result) == t.canonical_json(t.inspect_source(path))
    with pytest.raises(ValueError, match='video_stream_not_found'):
        t.inspect_source(path, stream_index=999)


def test_missing_pts_preserves_diagnostic(monkeypatch, tmp_path):
    t = api()
    frame = SimpleNamespace(pts=None, time_base=Fraction(1, 24), duration=0,
                            width=128, height=64, rotation=0)
    stream = SimpleNamespace(index=0, type='video', time_base=Fraction(1,24),
                             start_time=0, duration=None, sample_aspect_ratio=None,
                             codec_context=SimpleNamespace(name='h264', width=128, height=64))
    class Container:
        streams = [stream]
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def decode(self, selected): return iter([frame])
    monkeypatch.setattr(t.av, 'open', lambda path: Container())
    result = t.inspect_source(tmp_path / 'source')
    assert result['timing_status'] == 'unsupported'
    assert result['diagnostic_code'] == 'missing_or_invalid_pts'
    assert result['decoded_count'] == 1
    assert result['frames'][0]['duration'] is None


def test_corrupt_media_diagnostic(tmp_path):
    path = tmp_path / 'broken'; path.write_bytes(b'not video')
    result = api().inspect_source(path)
    assert result['timing_status'] == 'unsupported'
    assert result['diagnostic_code'] == 'decode_failed'


def test_audio_and_selected_second_video_stream(tmp_path):
    import subprocess
    source = make_clip(tmp_path / 'video.mp4')
    output = tmp_path / 'streams.mkv'
    subprocess.run(['ffmpeg', '-v', 'error', '-i', str(source), '-itsoffset', '0.125',
                    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3',
                    '-map', '0:v', '-map', '1:a', '-map', '0:v',
                    '-c:v', 'copy', '-c:a', 'pcm_s16le', str(output)],
                   capture_output=True, check=True, timeout=30)
    result = api().inspect_source(output, stream_index=2)
    assert result['stream_index'] == 2
    assert result['decoded_count'] == 8
    audio = next(s for s in result['streams'] if s['type'] == 'audio')
    assert audio['start_pts'] == 125
    assert audio['time_base'] == {'num': 1, 'den': 1000}


def test_invalid_index_and_denominator():
    invalid = rows([1]); invalid[0]['index'] = 2
    with pytest.raises(ValueError, match='invalid_frame_index'):
        api().validate_rows(invalid)
    invalid = rows([1]); invalid[0]['pts']['den'] = 0
    with pytest.raises(ValueError, match='missing_or_invalid_pts'):
        api().validate_rows(invalid)
