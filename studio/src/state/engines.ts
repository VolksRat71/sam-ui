// sam-ui (Apache-2.0). New file, not from SAM 2.

/** "sam2" -> "SAM 2", "sam3" -> "SAM 3"; other names as they are. */
export function engineLabel(name: string): string {
  const m = /^sam(\d+(?:\.\d+)?)$/i.exec(name);
  return m == null ? name : `SAM ${m[1]}`;
}
