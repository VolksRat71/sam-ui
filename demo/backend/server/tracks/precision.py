# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Numeric precision per engine (issue #11), read from the environment so the
app, the tests and tools/hardware_bench.py run the same code:

  SAM_UI_SAM3_DTYPE  fp32 (default), fp16 or bf16: SAM 3's weights, frames and
                     activations, tracker and detector alike. Half precision
                     takes SAM 3's peak footprint while tracking from 5.5 to
                     3.5 GB, and its time a frame from 1.35 to 0.8 s (M4 Max).
                     fp16 stays closer to fp32 than bf16 (mean mask IoU 0.996
                     against 0.99), so it is the one to pick.
  SAM_UI_SAM2_DTYPE  fp32 (default), fp16 or bf16: autocast for SAM 2 on MPS.
                     Twice as fast, but no smaller (the weights stay fp32 and
                     autocast keeps cast copies). On CUDA SAM 2 always runs
                     under bf16 autocast, as upstream.

Anything but fp32 moves masks: small objects most (a ball at under 1% of the
frame fell to IoU 0.80 against fp32 on some frames), so it is opt-in. The
README's Hardware section has the measurements.
"""
import contextlib
import os

NAMES = {"fp32": "float32", "float32": "float32", "bf16": "bfloat16", "bfloat16": "bfloat16",
         "fp16": "float16", "float16": "float16", "half": "float16"}


def dtype_name(var: str) -> str:
    """The torch dtype name an env var asks for ("float32" when unset).
    ValueError on anything else, so a typo fails loudly at load."""
    raw = os.environ.get(var, "").strip().lower() or "fp32"
    if raw not in NAMES:
        raise ValueError(f"{var}={raw!r}: use fp32, bf16 or fp16")
    return NAMES[raw]


def torch_dtype(var: str):
    import torch

    return getattr(torch, dtype_name(var))


def sam3_dtype():
    return torch_dtype("SAM_UI_SAM3_DTYPE")


def sam2_autocast(device_type: str):
    """The context SAM 2 runs under on `device_type` ("cuda", "mps", "cpu")."""
    import torch

    if device_type == "cuda":
        return torch.autocast("cuda", dtype=torch.bfloat16)
    if device_type == "mps":
        dt = torch_dtype("SAM_UI_SAM2_DTYPE")
        if dt != torch.float32:
            return torch.autocast("mps", dtype=dt)
    return contextlib.nullcontext()
