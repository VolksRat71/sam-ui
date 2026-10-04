from fractions import Fraction
from dataclasses import replace
import copy
import pytest
from asset_media_fixtures import make_clip, frame_ids
from data.assets import retain_upload
from data.assets.proxy_contract import load_source, ProxyRecipe, effective_recipe


def api():
    from data.assets import proxy_codec
    return proxy_codec


def source_asset(tmp_path, *, stamps=None, base=Fraction(1,24), bframes=False):
    source=make_clip(tmp_path/'input.mp4',pts=stamps,time_base=base,bframes=bframes)
    record=retain_upload(source,root=tmp_path/'assets',working_copy_sha256='a'*64,
                         start_time_sec=0,duration_time_sec=300)
    return load_source(tmp_path/'assets'/record['source_sha256'],max_frames=1000)


@pytest.mark.parametrize('base,stamps,bframes', [
    (Fraction(1,24),list(range(40)),True),
    (Fraction(1,30),list(range(8)),False),
    (Fraction(1,60),list(range(8)),False),
    (Fraction(1001,30000),list(range(8)),False),
    (Fraction(1,1000),[1000,1033,1075,1100],False),
])
def test_encode_exact_source_sequence(tmp_path,base,stamps,bframes):
    codec=api();source=source_asset(tmp_path,stamps=stamps,base=base,bframes=bframes)
    recipe=effective_recipe(source,ProxyRecipe(64,32));output=tmp_path/'proxy.mp4'
    codec.encode_proxy(source,recipe,output)
    validation=codec.validate_proxy(source,recipe,output)
    assert validation['frame_count']==len(stamps)
    assert validation['source_origin_offset']==source.inspection['frames'][0]['pts']
    # Sample at scaled block centers; cannot reuse unscaled fixture helper.
    import av
    with av.open(str(output)) as c:
        ids=[sum(1<<bit for bit in range(8) if f.to_ndarray(format='rgb24')[16,bit*8+4,0]>128) for f in c.decode(video=0)]
    assert ids==list(range(len(stamps)))


@pytest.mark.parametrize('kind',['count','pts','duration','geometry','source'])
def test_roundtrip_mismatch_refused(tmp_path,kind):
    codec=api();source=source_asset(tmp_path);recipe=effective_recipe(source,ProxyRecipe(64,32));output=tmp_path/'proxy.mp4'
    codec.encode_proxy(source,recipe,output)
    if kind=='source':source.path.write_bytes(b'modified')
    elif kind=='geometry':recipe['geometry']['proxy_raster']=[62,32]
    else:
        info=copy.deepcopy(source.inspection)
        if kind=='count':info['frames'].pop();info['decoded_count']-=1
        elif kind=='pts':info['frames'][2]['pts']={'num':1,'den':11}
        else:info['frames'][-1]['duration']={'num':1,'den':10}
        source=replace(source,inspection=info)
    with pytest.raises(ValueError):codec.validate_proxy(source,recipe,output)


def test_unrepresentable_time_base_refused(tmp_path):
    codec=api();source=source_asset(tmp_path)
    info=copy.deepcopy(source.inspection);info['frames'][1]['pts']={'num':1,'den':2147483649}
    with pytest.raises(ValueError,match='unrepresentable_time_base'):
        codec.time_base_for(replace(source,inspection=info))


def test_known_final_duration_preserved(tmp_path):
    codec=api();source=source_asset(tmp_path,stamps=[1000,1033,1075,1100],base=Fraction(1,1000))
    recipe=effective_recipe(source,ProxyRecipe());output=tmp_path/'proxy.mp4'
    codec.encode_proxy(source,recipe,output)
    assert codec.validate_proxy(source,recipe,output)['source_end'] is not None


def varied_asset(tmp_path, width, height, *, sar=Fraction(1), rotation=0, negative=False, conflicting_durations=False):
    import av
    import numpy as np
    import subprocess
    path=tmp_path/'raw.mp4'
    with av.open(str(path),'w',options={'avoid_negative_ts':'disabled'}) as out:
        s=out.add_stream('libx264',rate=24);s.width=width;s.height=height;s.pix_fmt='yuv444p'
        s.time_base=s.codec_context.time_base=Fraction(1,1000)
        s.codec_context.sample_aspect_ratio=sar;s.options={'crf':'0','bf':'0'}
        for i,pts in enumerate([0,40,80,120] if negative and not conflicting_durations else [0,33,75,100]):
            f=av.VideoFrame.from_ndarray(np.full((height,width,3),30+i*50,dtype=np.uint8),format='rgb24')
            f.pts=pts;f.time_base=Fraction(1,1000)
            for packet in s.encode(f):out.mux(packet)
        for packet in s.encode():out.mux(packet)
    if negative:
        shifted=tmp_path/'negative.ts'
        subprocess.run(['ffmpeg','-v','error','-i',str(path),'-vf','setpts=PTS-1/TB',
                        '-fps_mode','passthrough','-c:v','libx264','-bf','0',
                        '-mpegts_copyts','1','-muxdelay','0','-avoid_negative_ts','disabled',
                        '-f','mpegts',str(shifted)],capture_output=True,check=True,timeout=30)
        path=shifted
    if rotation:
        rotated=tmp_path/'rotated.mp4'
        subprocess.run(['ffmpeg','-v','error','-i',str(path),'-c','copy','-metadata:s:v:0',f'rotate={rotation}',str(rotated)],capture_output=True,check=True,timeout=30)
        path=rotated
    record=retain_upload(path,root=tmp_path/'assets',working_copy_sha256='a'*64,start_time_sec=0,duration_time_sec=300)
    return load_source(tmp_path/'assets'/record['source_sha256'],max_frames=100)


@pytest.mark.parametrize('width,height,sar,rotation', [(101,51,Fraction(1),0),(64,128,Fraction(1),0),(128,64,Fraction(4,3),90)])
def test_odd_portrait_and_display_geometry(tmp_path,width,height,sar,rotation):
    source=varied_asset(tmp_path,width,height,sar=sar,rotation=rotation)
    recipe=effective_recipe(source,ProxyRecipe(64,64));out=tmp_path/'proxy.mp4'
    api().encode_proxy(source,recipe,out)
    assert api().validate_proxy(source,recipe,out)['geometry_equal']
    assert recipe['geometry']['source_raster']==[width,height]


def test_negative_source_origin(tmp_path):
    source=varied_asset(tmp_path,128,64,negative=True)
    assert source.inspection['frames'][0]['pts']['num'] < 0, 'negative fixture was shifted'
    recipe=effective_recipe(source,ProxyRecipe());out=tmp_path/'proxy.mp4'
    api().encode_proxy(source,recipe,out)
    assert api().validate_proxy(source,recipe,out)['source_origin_offset']['num'] < 0


def test_unknown_end_not_invented(tmp_path):
    source=source_asset(tmp_path);info=copy.deepcopy(source.inspection)
    info['frames'][-1]['duration']=None;info['frames'][-1]['duration_source']=None
    source=replace(source,inspection=info)
    # The exact time-base derivation must not manufacture a last duration.
    assert api().time_base_for(source)==Fraction(1,24)


def test_non_quarter_display_matrix_refused():
    import struct
    from types import SimpleNamespace
    class Side:
        type=SimpleNamespace(name='DISPLAYMATRIX')
        def __bytes__(self):return struct.pack('=9i',65536,0,0,0,-65536,0,0,0,1<<30)
    with pytest.raises(ValueError,match='unsupported_display_transform'):
        api()._check_display_data(SimpleNamespace(side_data=[Side()]))


def test_conflicting_pts_and_durations_not_silently_retimed(tmp_path):
    source=varied_asset(tmp_path,128,64,negative=True,conflicting_durations=True)
    recipe=effective_recipe(source,ProxyRecipe());out=tmp_path/'proxy.mp4'
    api().encode_proxy(source,recipe,out)
    with pytest.raises(ValueError,match='proxy_duration_mismatch'):
        api().validate_proxy(source,recipe,out)
