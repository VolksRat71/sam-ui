// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Names: an object's display name, and the file names exports use, so
// nobody renames exported files by hand.
//   - Objects are "Object N" until renamed (N is id + 1; ids are never reused).
//   - A file name keeps Unicode letters, replaces / \ : * ? " < > | and
//     control characters with "-", collapses whitespace, and falls back to a
//     default when nothing is left.
//   - Duplicates get " (2)", " (3)", ... in object order, so they are stable.

export const NAME_MAX = 64;
const FILE_MAX = 120;

/** An object's name as shown: its own, else "Object N". */
export function objectName(o: {id: number; name?: string | null}): string {
  return o.name != null && o.name.trim() !== '' ? o.name : defaultObjectName(o.id);
}

export function defaultObjectName(id: number): string {
  return `Object ${id + 1}`;
}

/** A typed name as stored: trimmed, at most NAME_MAX characters; empty means the default (null). */
export function cleanObjectName(raw: string): string | null {
  const name = raw.trim().slice(0, NAME_MAX).trim();
  return name === '' ? null : name;
}

/** A name made safe as a file name (no extension), or `fallback`. */
export function safeFileName(name: string, fallback: string): string {
  let s = name
    .replace(/\s+/g, ' ') // tabs and newlines are whitespace first
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, '-')
    .trim()
    .replace(/^\.+/, ''); // no hidden files, no "..": a leading dot goes
  if ([...s].length > FILE_MAX) {
    s = [...s].slice(0, FILE_MAX).join('').trim();
  }
  return s === '' ? (fallback === name ? 'export' : safeFileName(fallback, 'export')) : s;
}

/** Safe names, made unique in order: the second "cup" is "cup (2)". Case-insensitive, as macOS is. */
export function uniqueFileNames(names: ReadonlyArray<string>, fallback: (i: number) => string): string[] {
  const seen = new Set<string>();
  return names.map((n, i) => {
    const base = safeFileName(n, fallback(i));
    let name = base;
    for (let k = 2; seen.has(name.toLowerCase()); k++) {
      name = `${base} (${k})`;
    }
    seen.add(name.toLowerCase());
    return name;
  });
}

/** A video path's file stem: "uploads/My clip.mp4" -> "My clip". */
export function videoStem(path: string): string {
  const file = path.split(/[/\\]/).pop() ?? path;
  return safeFileName(file.replace(/\.[^.]+$/, ''), 'video');
}

export type ExportFile = 'masks' | 'roto' | 'vectors' | 'video';

/** The export file name a dialog starts with, from the video's stem. */
export function defaultExportName(videoPath: string, kind: ExportFile): string {
  const stem = videoStem(videoPath);
  return kind === 'video' ? `${stem}-export.mp4` : `${stem}-${kind}.zip`;
}

/** A typed export file name, made safe, with its extension ensured. */
export function exportFileName(typed: string, fallback: string, ext: '.zip' | '.mp4'): string {
  const bare = typed.trim().replace(new RegExp(`\\${ext}$`, 'i'), '');
  return `${safeFileName(bare, fallback.replace(new RegExp(`\\${ext}$`, 'i'), ''))}${ext}`;
}

/** A product id for the roto layout (letters, digits, _ and -), from an object's name. */
export function productId(name: string, id: number): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^[_-]+|_+$/g, '')
    .toLowerCase()
    .slice(0, 64);
  return slug === '' ? `object_${id + 1}` : slug;
}
