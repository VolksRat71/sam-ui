# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Handing GPU memory back between jobs (issue #11).

PyTorch's MPS and CUDA allocators keep the blocks a job freed, for the next
job to reuse, and macOS counts them against the app (its physical footprint)
until they are released. release_cached() returns them; engines call it when a
job or a text prompt ends. It never touches memory a live tensor holds, so it
changes no result, only how much the idle app keeps.

clear_lru_caches() empties the functools caches transformers keeps on SAM 3's
classes (sine position embeddings, the DETR decoder's coordinates). They hold
about 110 MB of GPU tensors, one keyed on a detector module (so the module
outlives an unload), and a few live tensors keep whole allocator heaps from
being released: after a job and an unload, 3.1 GB of driver memory stayed
behind 0.15 GB of live tensors. They are pure functions of shape, device and
dtype, so clearing them changes no result.

idle_seconds() reads how long an engine part may sit unused before it is
unloaded (tracks/sam3_engine.py).
"""
import gc
import os
from typing import Optional


def release_cached() -> None:
    import torch

    gc.collect()  # tensors kept alive only by reference cycles go first
    if torch.backends.mps.is_available():
        torch.mps.empty_cache()
    elif torch.cuda.is_available():
        torch.cuda.empty_cache()


SAM3_MODULES = ("transformers.models.sam3.modeling_sam3",
                "transformers.models.sam3_tracker_video.modeling_sam3_tracker_video")


def clear_lru_caches(module_names=SAM3_MODULES) -> int:
    """cache_clear() every lru_cache on the classes of the named modules
    (only those already imported). transformers wraps them
    (compile_compatible_method_lru_cache), so the cache sits in the wrapper's
    closure. Returns how many were cleared."""
    import sys

    n = 0
    for name in module_names:
        mod = sys.modules.get(name)
        for cls in vars(mod).values() if mod is not None else ():
            if not isinstance(cls, type) or cls.__module__ != name:
                continue
            for attr in vars(cls).values():
                fn = getattr(attr, "__func__", attr)  # staticmethod, classmethod
                for f in (fn, *(c.cell_contents for c in (getattr(fn, "__closure__", None) or ())
                                if _filled(c))):
                    if callable(getattr(f, "cache_clear", None)):
                        f.cache_clear()
                        n += 1
    return n


def _filled(cell) -> bool:
    try:
        cell.cell_contents
    except ValueError:  # an empty cell
        return False
    return True


def idle_seconds(var: str, default: Optional[float]) -> Optional[float]:
    """Seconds from the env var `var` (default `default`): None means never
    unload ("never", "off", "" or a negative number), 0 unload as soon as
    unused. ValueError on anything else, so a typo fails loudly."""
    raw = os.environ.get(var)
    if raw is None:
        return default
    raw = raw.strip().lower()
    if raw in ("", "never", "off", "keep"):
        return None
    try:
        v = float(raw)
    except ValueError:
        raise ValueError(f"{var}={raw!r}: use a number of seconds, or never") from None
    return None if v < 0 else v
