"""Opt-in durable publication. Nothing here changes application video bindings."""
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile

import av

from .proxy_codec import encode_proxy, validate_proxy
from .proxy_contract import ProxyRecipe, effective_recipe, load_source, proxy_id, safe_path
from .retention import _directory, _fsync_directory, _hash, _read, _write
from .timing import canonical_json


def _enabled() -> None:
    setting = os.environ.get('SAM_UI_GENERATE_FRAME_ACCURATE_PROXIES','0')
    if setting not in ('0','1'):
        raise ValueError('invalid_proxy_flag')
    if setting != '1':
        raise ValueError('proxy_generation_disabled')


def _reuse(destination, source, recipe, identity):
    safe_path(destination)
    manifest = json.loads(_read(destination/'proxy.json'))
    if (manifest.get('schema_version') != 1 or manifest.get('status') != 'ready'
            or manifest.get('proxy_id') != identity or manifest.get('asset_id') != source.asset_id
            or manifest.get('frame_table_hash') != source.frame_table_hash
            or manifest.get('recipe') != recipe):
        raise ValueError('proxy_manifest_mismatch')
    artifact = destination/'video.mp4'
    if _hash(artifact) != manifest['provenance']['artifact_sha256']:
        raise ValueError('proxy_artifact_hash_mismatch')
    if validate_proxy(source,recipe,artifact) != manifest['validation']:
        raise ValueError('proxy_validation_mismatch')
    # A previous publisher may have failed on fsync after the atomic rename.
    _fsync_directory(destination)
    _fsync_directory(destination.parent)
    return manifest


def build_proxy(asset_dir: Path, proxy_root: Path, recipe: ProxyRecipe,
                max_frames: int) -> dict:
    """Return a validated ready manifest; flag OFF performs no filesystem I/O.

    Existing variants are validated and reused, never overwritten. Artifact bytes
    and library builds are provenance, not identity. Only our staging is cleaned.
    """
    _enabled()
    stage = None
    try:
        source = load_source(Path(asset_dir),max_frames=max_frames)
        effective = effective_recipe(source,recipe)
        identity = proxy_id(source,effective)
        proxy_root = Path(proxy_root)
        safe_path(proxy_root)
        destination = proxy_root/identity
        if destination.exists() or destination.is_symlink():
            return _reuse(destination,source,effective,identity)
        _directory(proxy_root)
        stage = Path(tempfile.mkdtemp(prefix='.stage-',dir=proxy_root))
        artifact = stage/'video.mp4'
        encode_proxy(source,effective,artifact)
        fd = os.open(artifact,os.O_RDONLY|os.O_NOFOLLOW)
        try:os.fsync(fd)
        finally:os.close(fd)
        validation = validate_proxy(source,effective,artifact)
        manifest = dict(schema_version=1,status='ready',proxy_id=identity,
                        asset_id=source.asset_id,frame_table_hash=source.frame_table_hash,
                        source_sha256=source.source_sha256,recipe=effective,validation=validation,
                        provenance=dict(artifact_sha256=_hash(artifact),pyav_version=av.__version__,
                                        libraries={k:list(v) for k,v in av.library_versions.items()}))
        _write(stage/'proxy.json',canonical_json(manifest))
        _fsync_directory(stage)
        if _hash(source.path) != source.source_sha256:
            raise ValueError('original_hash_mismatch')
        try:
            os.rename(stage,destination)
            stage = None
        except OSError as exc:
            if exc.errno not in (errno.EEXIST,errno.ENOTEMPTY):raise
            return _reuse(destination,source,effective,identity)
        _fsync_directory(proxy_root)
        return manifest
    except OSError as exc:
        raise ValueError('proxy_storage_failed') from exc
    except (KeyError,TypeError,json.JSONDecodeError) as exc:
        raise ValueError('invalid_proxy_metadata') from exc
    except av.FFmpegError as exc:
        raise ValueError('proxy_encoding_failed') from exc
    except ValueError as exc:
        # Avoid embedding local paths/decoder diagnostics into command output.
        code = str(exc)
        if not re.fullmatch('[a-z][a-z0-9_]*',code):code='proxy_generation_failed'
        raise ValueError(code) from exc
    finally:
        if stage is not None:
            shutil.rmtree(stage)
