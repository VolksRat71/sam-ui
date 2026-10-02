from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import sys
import pytest
from test_proxy_contract import asset
from data.assets.proxy_contract import ProxyRecipe


def api():
    from data.assets import proxy
    return proxy


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setenv('SAM_UI_GENERATE_FRAME_ACCURATE_PROXIES','1')


def build(directory,root):
    return api().build_proxy(directory,root,ProxyRecipe(64,32),100)


@pytest.mark.parametrize('value',[None,'0','yes'])
def test_disabled_or_invalid_flag_no_io(tmp_path,monkeypatch,value):
    if value is None:monkeypatch.delenv('SAM_UI_GENERATE_FRAME_ACCURATE_PROXIES',raising=False)
    else:monkeypatch.setenv('SAM_UI_GENERATE_FRAME_ACCURATE_PROXIES',value)
    root=tmp_path/'new'/'proxies'
    with pytest.raises(ValueError,match='proxy_generation_disabled|invalid_proxy_flag'):
        build(tmp_path/'missing-source',root)
    assert not root.parent.exists()


def test_ready_manifest_and_reuse(tmp_path,enabled):
    directory=asset(tmp_path);root=tmp_path/'proxies';result=build(directory,root)
    assert result['status']=='ready' and result['validation']['frame_count']==8
    destination=root/result['proxy_id']
    assert (destination/'video.mp4').is_file()
    assert json.loads((destination/'proxy.json').read_text())==result
    assert build(directory,root)==result
    assert result['provenance']['artifact_sha256']
    assert not list(root.glob('.stage-*'))


def test_concurrent_builds_keep_valid_winner(tmp_path,enabled):
    directory=asset(tmp_path);root=tmp_path/'proxies'
    with ThreadPoolExecutor(max_workers=3) as pool:
        results=list(pool.map(lambda _:build(directory,root),range(3)))
    assert all(r==results[0] for r in results)
    assert len(list(root.glob('*/proxy.json')))==1
    assert not list(root.glob('.stage-*'))


@pytest.mark.parametrize('kind',['video','manifest','source'])
def test_corruption_refused_not_replaced(tmp_path,enabled,kind):
    directory=asset(tmp_path);root=tmp_path/'proxies';result=build(directory,root)
    target=(root/result['proxy_id']/('video.mp4' if kind=='video' else 'proxy.json')) if kind!='source' else next(directory.glob('original.*'))
    target.write_bytes(b'corrupt')
    with pytest.raises(ValueError):build(directory,root)
    assert target.read_bytes()==b'corrupt'


@pytest.mark.parametrize('point',['encode','validation','rename','fsync'])
def test_failure_cleans_only_attempt(tmp_path,enabled,monkeypatch,point):
    p=api();directory=asset(tmp_path);root=tmp_path/'proxies'
    def fail(*args,**kwargs):raise OSError('injected /private/server/path')
    target={'encode':(p,'encode_proxy'),'validation':(p,'validate_proxy'),
            'rename':(p.os,'rename'),'fsync':(p.os,'fsync')}[point]
    monkeypatch.setattr(*target,fail)
    with pytest.raises(ValueError) as exc:build(directory,root)
    assert '/private' not in str(exc.value)
    assert not list(root.glob('*/proxy.json'))
    assert not list(root.glob('.stage-*'))
    assert next(directory.glob('original.*')).is_file()


def test_budget_refused_before_creating_proxy_root(tmp_path,enabled):
    directory=asset(tmp_path);root=tmp_path/'proxies'
    with pytest.raises(ValueError,match='frame_budget_exceeded'):
        api().build_proxy(directory,root,ProxyRecipe(),7)
    assert not root.exists()


def test_original_changes_during_encode_refused(tmp_path,enabled,monkeypatch):
    p=api();directory=asset(tmp_path);root=tmp_path/'proxies';real=p.encode_proxy
    def changed(source,recipe,out):
        real(source,recipe,out);source.path.write_bytes(b'changed')
    monkeypatch.setattr(p,'encode_proxy',changed)
    with pytest.raises(ValueError,match='original_hash_mismatch'):build(directory,root)
    assert not list(root.glob('*/proxy.json'))


def test_cli_explicit_build_and_disabled(tmp_path,enabled):
    directory=asset(tmp_path);root=tmp_path/'proxies'
    server=Path(__file__).resolve().parents[1]/'server'
    env=dict(os.environ,PYTHONPATH=str(server))
    command=[sys.executable,'-m','data.assets.proxy_cli','--asset-dir',str(directory),
             '--proxy-root',str(root),'--max-frames','100','--max-width','64','--max-height','32']
    result=subprocess.run(command,env=env,capture_output=True,text=True,timeout=30)
    assert result.returncode==0,result.stderr
    assert json.loads(result.stdout)['status']=='ready'
    env['SAM_UI_GENERATE_FRAME_ACCURATE_PROXIES']='0'
    result=subprocess.run(command,env=env,capture_output=True,text=True,timeout=30)
    assert result.returncode!=0
    assert json.loads(result.stderr)['error']=='proxy_generation_disabled'


def test_post_rename_sync_failure_keeps_complete_variant_for_retry(tmp_path,enabled,monkeypatch):
    p=api();directory=asset(tmp_path);root=tmp_path/'proxies';real=p._fsync_directory
    def fail_after_publish(path):
        if path==root and list(root.glob('*/proxy.json')):raise OSError('sync failed')
        real(path)
    monkeypatch.setattr(p,'_fsync_directory',fail_after_publish)
    with pytest.raises(ValueError,match='proxy_storage_failed'):build(directory,root)
    assert len(list(root.glob('*/video.mp4')))==1
    monkeypatch.setattr(p,'_fsync_directory',real)
    assert build(directory,root)['status']=='ready'


def test_process_exit_during_encode_never_publishes_ready(tmp_path,enabled):
    directory=asset(tmp_path);root=tmp_path/'proxies'
    server=Path(__file__).resolve().parents[1]/'server'
    code='''import os,sys
from pathlib import Path
from data.assets import proxy
from data.assets.proxy_contract import ProxyRecipe
def interrupted(source,recipe,out):
    out.write_bytes(b"partial")
    os._exit(7)
proxy.encode_proxy=interrupted
proxy.build_proxy(Path(sys.argv[1]),Path(sys.argv[2]),ProxyRecipe(64,32),100)
'''
    result=subprocess.run([sys.executable,'-c',code,str(directory),str(root)],
                         env=dict(os.environ,PYTHONPATH=str(server)),capture_output=True,timeout=30)
    assert result.returncode==7
    assert not list(root.glob('*/proxy.json'))
    debris=list(root.glob('.stage-*'));assert debris
    assert build(directory,root)['status']=='ready'
    assert all(p.exists() for p in debris), 'retry must not remove another attempt staging'


def test_symlink_variant_refused(tmp_path,enabled):
    directory=asset(tmp_path);root=tmp_path/'proxies';record=build(directory,root)
    variant=root/record['proxy_id'];moved=tmp_path/'elsewhere';variant.rename(moved)
    variant.symlink_to(moved,target_is_directory=True)
    with pytest.raises(ValueError,match='symlink_asset_path'):build(directory,root)


def test_reencoding_bytes_do_not_define_proxy_identity(tmp_path,enabled,monkeypatch):
    p=api();directory=asset(tmp_path);first=build(directory,tmp_path/'one')
    original_encode=p.encode_proxy
    def byte_different(source,recipe,out):
        original_encode(source,recipe,out)
        # A legal trailing MP4 free box changes bytes without changing recipe/content.
        with out.open('ab') as f:f.write(b'\x00\x00\x00\x0cfreeABCD')
    monkeypatch.setattr(p,'encode_proxy',byte_different)
    second=build(directory,tmp_path/'two')
    assert first['proxy_id']==second['proxy_id']
    assert first['provenance']['artifact_sha256']!=second['provenance']['artifact_sha256']
