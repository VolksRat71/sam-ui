# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Text prompts (issue #22): a phrase ("dog") as an object's seed on one frame.

A text prompt is a primitive, not discovery. It runs on ONE frame, the one on
screen, for ONE object:
  - an engine that reads text (SAM 3's detector) finds the phrase's instances
    on that frame and the best-scoring one becomes the frame's approved mask;
    when several match, the answer says how many, and a click refines the
    pick (clicks on a text frame refine its mask, as on any seed frame);
  - the seed stores the text beside that mask and no clicks:
    {"points": [], "labels": [], "text": "dog", "mask": RLE};
  - track jobs condition on the mask, as they do for every seed, so any
    engine (SAM 2 too) tracks a text-seeded object;
  - a phrase that matches nothing on the frame stores nothing.
Looking for the phrase across the clip, candidate spans and the like are later
work (see the issue's follow-ups); they would build on this.
"""
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

MAX_LEN = 200  # characters; SAM 3's tokenizer reads 32 tokens anyway

# The detector score a match needs: the checkpoint's own
# score_threshold_detection (sam3-hf config.json), which its video model uses.
THRESHOLD = 0.5


@dataclass
class TextMatch:
    """What an engine found for a phrase on one frame: the best instance's
    mask (HxW bool, None when nothing matched), its score, how many instances
    matched, and its box [x0, y0, x1, y1] in pixels."""

    mask: Optional[np.ndarray]
    score: float
    instances: int
    box: Optional[List[float]]


def normalize(text) -> str:
    """The prompt as stored: whitespace collapsed, at most MAX_LEN characters.
    ValueError when there is no text."""
    if not isinstance(text, str):
        raise ValueError("a text prompt must be a string")
    text = " ".join(text.split())[:MAX_LEN].strip()
    if not text:
        raise ValueError("a text prompt needs some text")
    return text


def has_prompt(seed: Dict) -> bool:
    """Whether a seed frame conditions tracking: it has clicks, or a text prompt."""
    return bool(seed.get("points")) or bool(seed.get("text"))


def pick(scores: Sequence[float], threshold: float = THRESHOLD) -> Tuple[Optional[int], int, float]:
    """(index of the best instance, or None when none reaches `threshold`;
    how many do; the best score)."""
    scores = [float(s) for s in scores]
    if not scores:
        return None, 0, 0.0
    best = max(range(len(scores)), key=scores.__getitem__)
    n = sum(1 for s in scores if s > threshold)
    return (best if n else None), n, scores[best]
