from fractions import Fraction
import hashlib
import json
import pytest
from asset_media_fixtures import make_clip
from data.assets import retain_upload


def api():
    from data.assets import proxy_contract
    return proxy_contract


def asset(tmp_path):
    clip = make_clip(tmp_path / 'source.mp4')
    record = retain_upload(clip, root=tmp_path / 'assets', working_copy_sha256='a'*64,
                           start_time_sec=0, duration_time_sec=1)
    return tmp_path / 'assets' / record['source_sha256']


def test_capped_geometry_is_invertible():
    p = api()
    geometry = p.geometry_for(1921, 1081, 90, Fraction(1), p.ProxyRecipe())
    assert geometry['proxy_raster'] == [1278, 720]
    assert geometry['source_raster'] == [1921, 1081]
    assert geometry['source_rotation'] == 90
    sx = Fraction(geometry['scale_x']['num'], geometry['scale_x']['den'])
    assert sx == Fraction(1278,1921)
    # Pixel centers including the outer edges round-trip without guessed cap ratios.
    for x in [0, 960, 1920]:
        xp = (Fraction(x) + Fraction(1,2))*sx-Fraction(1,2)
        assert (xp+Fraction(1,2))/sx-Fraction(1,2) == x


@pytest.mark.parametrize('dims,caps,want', [((101,51),(1280,720),[100,50]), ((1080,1920),(1280,720),[404,720]), ((640,480),(320,200),[266,200])])
def test_dimensions(dims,caps,want):
    p=api(); assert p.geometry_for(*dims,0,Fraction(1),p.ProxyRecipe(*caps))['proxy_raster']==want


@pytest.mark.parametrize('args', [(1,720),(0,720),(-2,720),(3.5,720),(True,720)])
def test_invalid_recipe(args):
    with pytest.raises(ValueError): api().ProxyRecipe(*args)


def test_unsupported_geometry():
    p=api()
    for width,height,rotation,sar in [(1,10,0,Fraction(1)),(100,100,45,Fraction(1)),(100,100,0,Fraction(0))]:
        with pytest.raises(ValueError): p.geometry_for(width,height,rotation,sar,p.ProxyRecipe())


def test_source_identity_and_recipe(tmp_path):
    p=api(); source=p.load_source(asset(tmp_path),max_frames=100)
    a=p.effective_recipe(source,p.ProxyRecipe())
    b=p.effective_recipe(source,p.ProxyRecipe(64,32))
    assert p.proxy_id(source,a)!=p.proxy_id(source,b)
    assert 'artifact_sha256' not in a and 'encoder_build' not in a
    assert a['encoder']['b_frames']==0 and a['encoder']['crf']==23
    assert p.proxy_id(source,a)==p.proxy_id(source,dict(a))


@pytest.mark.parametrize('corrupt', ['source','table','manifest'])
def test_source_corruption(tmp_path,corrupt):
    p=api(); directory=asset(tmp_path)
    target=next(directory.glob('original.*')) if corrupt=='source' else directory/('frames.0.json' if corrupt=='table' else 'asset.json')
    target.write_bytes(b'corruption')
    with pytest.raises(ValueError):p.load_source(directory,max_frames=100)


def test_budget_and_unsupported_table(tmp_path):
    p=api(); directory=asset(tmp_path)
    with pytest.raises(ValueError,match='frame_budget_exceeded'):p.load_source(directory,max_frames=7)
    manifest=json.loads((directory/'asset.json').read_text());manifest['frame_table_hash']=None
    (directory/'asset.json').write_text(json.dumps(manifest))
    with pytest.raises(ValueError,match='unsupported_source_timing'):p.load_source(directory,max_frames=100)
