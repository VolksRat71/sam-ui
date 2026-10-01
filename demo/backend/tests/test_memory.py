# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Lowering the memory floor (issue #11): the precision switches. No model is
loaded here; the real-model checks are in test_text.py and test_streaming.py
(SAM_UI_SLOW=1)."""
import contextlib

import pytest

from tracks import precision


def test_precision_names(monkeypatch):
    monkeypatch.delenv("SAM_UI_SAM3_DTYPE", raising=False)
    assert precision.dtype_name("SAM_UI_SAM3_DTYPE") == "float32"
    for raw, want in (("bf16", "bfloat16"), ("FP16", "float16"), ("fp32", "float32"), (" bfloat16 ", "bfloat16")):
        monkeypatch.setenv("SAM_UI_SAM3_DTYPE", raw)
        assert precision.dtype_name("SAM_UI_SAM3_DTYPE") == want
    monkeypatch.setenv("SAM_UI_SAM3_DTYPE", "int8")
    with pytest.raises(ValueError, match="fp32, bf16 or fp16"):
        precision.sam3_dtype()


def test_sam2_autocast_is_off_unless_asked(monkeypatch):
    import torch

    monkeypatch.delenv("SAM_UI_SAM2_DTYPE", raising=False)
    assert isinstance(precision.sam2_autocast("mps"), contextlib.nullcontext)
    assert isinstance(precision.sam2_autocast("cpu"), contextlib.nullcontext)
    monkeypatch.setenv("SAM_UI_SAM2_DTYPE", "bf16")
    ctx = precision.sam2_autocast("mps")
    assert isinstance(ctx, torch.autocast) and ctx.fast_dtype == torch.bfloat16
    assert isinstance(precision.sam2_autocast("cpu"), contextlib.nullcontext)  # MPS only
