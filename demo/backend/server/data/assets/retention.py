"""Opt-in immutable originals; these records are not inference bindings."""
import errno
import hashlib
import math
import os
from pathlib import Path
import re
import shutil
import tempfile

from .timing import canonical_json, inspect_source


def _directory(path: Path) -> None:
    # Managed descendants may never redirect writes through symlinks.
    if any(part.is_symlink() for part in (path, *path.parents)):
        raise ValueError('symlink_directory')
    if not path.parent.exists():
        _directory(path.parent)
    path.mkdir(exist_ok=True)
    if not path.is_dir() or path.is_symlink():
        raise ValueError('invalid_directory')
    # A synced child does not make its own entry in the parent durable.
    # Sync even on reuse: another uploader may have just created it.
    _fsync_directory(path.parent)


def _fsync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _read(path: Path) -> bytes:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        return stream.read()


def _hash(path: Path) -> str:
    digest = hashlib.sha256()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _write(path: Path, data: bytes) -> None:
    with path.open('xb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def _extension(path: Path) -> str:
    with path.open('rb') as stream:
        header = stream.read(4096)
    if header[4:8] == b'ftyp':
        return 'mov' if header[8:12] == b'qt  ' else 'mp4'
    if header[:4] == b'RIFF' and header[8:12] == b'AVI ':
        return 'avi'
    if header[:4] == b'\x1a\x45\xdf\xa3':
        return 'webm' if b'webm' in header else 'mkv'
    return 'bin'


def _publish_association(directory: Path, record: dict) -> None:
    _directory(directory.parent)
    _directory(directory)
    content = canonical_json(record)
    destination = directory / (hashlib.sha256(content).hexdigest() + '.json')
    fd, name = tempfile.mkstemp(prefix='.association-', dir=directory)
    temporary = Path(name)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            # An exclusive hard-link publish cannot overwrite a concurrent record.
            os.link(temporary, destination)
        except FileExistsError:
            if _read(destination) != content:
                raise ValueError('association_conflict')
        _fsync_directory(directory)
    finally:
        temporary.unlink(missing_ok=True)


def retain_upload(source_path: Path, *, root: Path, working_copy_sha256: str,
                  start_time_sec: float, duration_time_sec: float) -> dict:
    """Keep full source bytes, timing and an additive legacy-output association.

    A malformed timeline is retained with an unsupported diagnostic. Storage
    failure fails the opt-in upload; it never silently reports retention success.
    No shared published asset is deleted, even if subsequent publication fails.
    """
    if not re.fullmatch(r'[0-9a-f]{64}', working_copy_sha256):
        raise ValueError('invalid_working_copy_hash')
    if any(not math.isfinite(v) or v < 0 for v in (start_time_sec, duration_time_sec)):
        raise ValueError('invalid_working_range')
    stage = None
    try:
        _directory(root)
        stage = Path(tempfile.mkdtemp(prefix='.stage-', dir=root))
        original = stage / 'original.bin'
        digest = hashlib.sha256()
        with source_path.open('rb') as src, original.open('xb') as dst:
            while chunk := src.read(1024 * 1024):
                digest.update(chunk)
                dst.write(chunk)
            dst.flush()
            os.fsync(dst.fileno())
        source_hash = digest.hexdigest()
        extension = _extension(original)
        renamed = stage / f'original.{extension}'
        if renamed != original:
            original.rename(renamed)
        original = renamed
        inspection = inspect_source(original)
        asset_id = hashlib.sha256(canonical_json(dict(source_sha256=source_hash,
                                     stream_index=inspection['stream_index']))).hexdigest()
        table = dict(schema_version=1, asset_id=asset_id,
                     stream_index=inspection['stream_index'], frames=inspection['frames'])
        table_bytes = canonical_json(table)
        table_hash = (hashlib.sha256(table_bytes).hexdigest()
                      if inspection['timing_status'] == 'valid' else None)
        table_name = f"frames.{inspection['stream_index']}.json"
        manifest = dict(schema_version=1, source_sha256=source_hash,
                        asset_id=asset_id, original_name=original.name,
                        inspection=inspection, frame_table_hash=table_hash)
        manifest_bytes = canonical_json(manifest)
        _write(stage / 'asset.json', manifest_bytes)
        _write(stage / table_name, table_bytes)
        _fsync_directory(stage)
        destination = root / source_hash
        if destination.is_symlink():
            raise ValueError('symlink_asset')
        try:
            os.rename(stage, destination)
            stage = None
            _fsync_directory(root)
        except OSError as exc:
            if exc.errno not in (errno.EEXIST, errno.ENOTEMPTY):
                raise
            if destination.is_symlink() or not destination.is_dir():
                raise ValueError('invalid_asset_directory') from exc
            if (_hash(destination / original.name) != source_hash
                    or _read(destination / 'asset.json') != manifest_bytes
                    or _read(destination / table_name) != table_bytes):
                raise ValueError('existing_asset_corrupt') from exc
        record = dict(schema_version=1, asset_id=asset_id, source_sha256=source_hash,
                      original_path=f'{source_hash}/{original.name}',
                      working_copy_sha256=working_copy_sha256,
                      start_time_sec=start_time_sec, duration_time_sec=duration_time_sec,
                      timing_mode='legacy_retimed', frame_accurate_export=False,
                      source_timing_status=inspection['timing_status'])
        _publish_association(root / 'working-copies' / working_copy_sha256, record)
        return record
    except (OSError, ValueError) as exc:
        raise ValueError('original_retention_failed') from exc
    finally:
        if stage is not None:
            shutil.rmtree(stage)
