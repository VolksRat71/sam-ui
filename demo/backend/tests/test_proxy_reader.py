"""Explicit cross-branch gate: run against the real PR #25 checkout, never a copy.

SAM_UI_PROXY_READER_CHECKOUT=/path/to/checkout SAM_UI_PROXY_READER_REVISION=<sha> \
    python -m pytest demo/backend/tests/test_proxy_reader.py -q

No model is loaded. Without an explicitly supplied checkout this integration
check is skipped; passing the default suite alone does not satisfy this gate.
"""
from fractions import Fraction
import os
from pathlib import Path
import subprocess
import sys

import av
import numpy as np
import pytest

from data.assets import retain_upload
from data.assets.proxy import build_proxy
from data.assets.proxy_contract import ProxyRecipe
from asset_media_fixtures import make_clip

READER=os.environ.get('SAM_UI_PROXY_READER_CHECKOUT')

# Independent content oracle uses the literal frame-ID blocks in synthetic media.
READER_PROGRAM=r'''
from pathlib import Path
import sys
from types import SimpleNamespace
import numpy as np
import torch
import tracks.streaming as reader
import sam2.utils.misc as misc
checkout=Path(sys.argv[1]).resolve()
assert Path(reader.__file__).resolve()==checkout/'demo/backend/server/tracks/streaming.py'
assert Path(misc.__file__).resolve()==checkout/'sam2/utils/misc.py'
path=sys.argv[2];n=int(sys.argv[3])
runs=reader._PyAVRuns(path,run=5)
sam2=reader.Sam2Frames(path,128,img_mean=(0,0,0),img_std=(1,1,1))
class Processor:
    def video_processor(self,*,videos,return_tensors):
        return SimpleNamespace(pixel_values_videos=[torch.from_numpy(videos[0])])
sam3=reader.Sam3Frames(path,Processor())
assert runs.n==len(sam2)==len(sam3)==n
order=list(range(n))+list(range(n-1,-1,-1))+list(np.random.default_rng(17).permutation(n))
def frame_id(array):
    h,w=array.shape[:2]
    return sum(1<<b for b in range(8) if array[h//2,int((b+0.5)*w/8),0]>128)
for i in order:
    i=int(i)
    assert frame_id(runs.get(i).numpy())==i, ('raw',i)
    assert frame_id((sam2[i].permute(1,2,0).numpy()*255))==i, ('sam2',i)
    assert frame_id(sam3[i].numpy())==i, ('sam3',i)
print('reader parity passed')
'''


@pytest.mark.skipif(not READER,reason='explicit PR #25 reader checkout required')
@pytest.mark.parametrize('kind',['bframes','vfr','fractional','late_origin'])
def test_actual_reader_preserves_source_indices(tmp_path,monkeypatch,kind):
    checkout=Path(READER)
    revision=os.environ.get('SAM_UI_PROXY_READER_REVISION')
    assert revision, 'pin reader commit explicitly'
    head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=checkout,text=True).strip()
    assert head==revision, 'reader checkout changed; review and repin before acceptance'
    n=40
    base=Fraction(1,1000) if kind in ('vfr','late_origin') else Fraction(1001,30000) if kind=='fractional' else Fraction(1,24)
    stamps=[1000+i*33+(i//3)*9 for i in range(n)] if kind=='vfr' else [1000+i*40 for i in range(n)] if kind=='late_origin' else list(range(n))
    source=make_clip(tmp_path/'source.mp4',pts=stamps,time_base=base,bframes=kind=='bframes')
    retained=retain_upload(source,root=tmp_path/'assets',working_copy_sha256='a'*64,start_time_sec=0,duration_time_sec=300)
    monkeypatch.setenv('SAM_UI_GENERATE_FRAME_ACCURATE_PROXIES','1')
    root=tmp_path/'proxies'
    manifest=build_proxy(tmp_path/'assets'/retained['source_sha256'],root,ProxyRecipe(64,32),100)
    proxy=root/manifest['proxy_id']/'video.mp4'
    env=dict(os.environ,PYTHONPATH=os.pathsep.join([str(checkout),str(checkout/'demo/backend/server')]))
    for clip in (source,proxy):
        result=subprocess.run([sys.executable,'-c',READER_PROGRAM,str(checkout),str(clip),str(n)],
                              cwd=checkout,env=env,capture_output=True,text=True,timeout=60)
        assert result.returncode==0,result.stdout+result.stderr
        assert 'reader parity passed' in result.stdout


@pytest.mark.parametrize('ids',[[1,0,2,3],[0,1,1,3],[0,1,3]])
def test_frame_id_oracle_detects_content_faults(tmp_path,ids):
    # Explicit fault injection proves the content check catches what PTS alone cannot.
    path=tmp_path/'wrong.mp4'
    with av.open(str(path),'w') as out:
        stream=out.add_stream('libx264',rate=24);stream.width=128;stream.height=64;stream.pix_fmt='yuv420p'
        stream.options={'crf':'0','bf':'0'}
        for index,value in enumerate(ids):
            pixels=np.zeros((64,128,3),dtype=np.uint8)
            for bit in range(8):pixels[:,bit*16:(bit+1)*16]=235 if value&(1<<bit) else 16
            frame=av.VideoFrame.from_ndarray(pixels,format='rgb24');frame.pts=index
            for packet in stream.encode(frame):out.mux(packet)
        for packet in stream.encode():out.mux(packet)
    from asset_media_fixtures import frame_ids
    assert frame_ids(path)!=list(range(4))
