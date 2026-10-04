// sam-ui (Apache-2.0). New file, not from SAM 2.

/**
 * Runs of frames with a non-empty mask, as [first, last] pairs, for the
 * timeline swimlanes. `masks` is sparse: a missing frame counts as empty.
 */
export function maskSegments(
  masks: ReadonlyArray<{isEmpty: boolean} | undefined>,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < masks.length; i++) {
    const on = masks[i] != null && !masks[i]!.isEmpty;
    if (on && start === -1) {
      start = i;
    } else if (!on && start !== -1) {
      out.push([start, i - 1]);
      start = -1;
    }
  }
  if (start !== -1) {
    out.push([start, masks.length - 1]);
  }
  return out;
}

/** Whether `frame` is in one of `segments` (the frame shows a mask). */
export function maskedAt(segments: ReadonlyArray<[number, number]> | undefined, frame: number): boolean {
  return segments?.some(([a, b]) => a <= frame && frame <= b) ?? false;
}
