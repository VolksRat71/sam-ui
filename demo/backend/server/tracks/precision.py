# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Numeric precision per engine (issue #11), read from the environment so the
app, the tests and tools/hardware_bench.py run the same code:

  SAM_UI_SAM3_DTYPE  fp16 (the default on MPS), fp32 (the default elsewhere)
                     or bf16: SAM 3's weights, frames and activations, tracker
                     and detector alike. On an M4 Max fp16 takes SAM 3's peak
                     footprint while tracking from 5.3-5.5 to 3.7-4.7 GB and
                     its time a frame from 1.33 to about 0.8 s, and every mask
                     on the gallery and synthetic clips stays at IoU 0.96 or
                     more against fp32 (mean 0.995 to 0.999). bf16 saves the
                     same but moves masks more (lowest 0.92). fp32 is set
                     explicitly to get full precision back. CUDA keeps fp32
                     until it is measured there.
  SAM_UI_SAM2_DTYPE  fp32 (default), fp16 or bf16: autocast for SAM 2 on MPS.
                     Twice as fast, but no smaller (the weights stay fp32 and
                     autocast keeps cast copies), and bf16 lost the dog on one
                     frame of the gallery clip, so it stays opt-in. On CUDA
                     SAM 2 always runs under bf16 autocast, as upstream.

docs/hardware.md has the measurements; test_text.py's slow
test_real_sam3_half_precision_track_stays_close_to_fp32 checks them.
"""
import contextlib
import os

NAMES = {"fp32": "float32", "float32": "float32", "bf16": "bfloat16", "bfloat16": "bfloat16",
         "fp16": "float16", "float16": "float16", "half": "float16"}


def dtype_name(var: str, default: str = "fp32") -> str:
    """The torch dtype name an env var asks for (`default` when unset).
    ValueError on anything else, so a typo fails loudly at load."""
    raw = os.environ.get(var, "").strip().lower() or default
    if raw not in NAMES:
        raise ValueError(f"{var}={raw!r}: use fp32, bf16 or fp16")
    return NAMES[raw]


def torch_dtype(var: str, default: str = "fp32"):
    import torch

    return getattr(torch, dtype_name(var, default))


def sam3_dtype(device_type: str):
    """SAM 3's dtype on `device_type`: fp16 on MPS unless SAM_UI_SAM3_DTYPE says otherwise."""
    return torch_dtype("SAM_UI_SAM3_DTYPE", "fp16" if device_type == "mps" else "fp32")


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
