// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The Export panel's form: which objects go into the rotoscoping working
// folder (POST /export), under what product id, prompt and colour. The
// backend checks the same rules; checking here first keeps the round trip
// for real refusals (a folder outside the export root, existing decisions).
import type {StudioObject} from './objects';

export const PRODUCT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

export type ExportRow = {
  objectId: number;
  include: boolean;
  id: string;
  prompt: string;
  color: string;
};

export type ExportOptions = {
  outDir: string;
  includeStale: boolean;
  frames: boolean;
  force: boolean;
};

/** The request body's `objects`: {obj_id: {id, prompt, color}}. */
export type ExportObjects = Record<string, {id: string; prompt: string; color: string}>;

export function defaultRows(objects: ReadonlyArray<StudioObject>): ExportRow[] {
  return objects
    .filter(o => o.state === 'tracked' || o.state === 'stale')
    .map(o => ({
      objectId: o.id,
      include: true, // a stale row is sent only with include stale on
      id: `object_${o.id + 1}`,
      prompt: `object ${o.id + 1}`,
      color: o.color.toLowerCase(),
    }));
}

/** Rows that would be sent: included, and stale ones only when allowed. */
export function selectedRows(
  rows: ReadonlyArray<ExportRow>,
  stateOf: (id: number) => string | undefined,
  includeStale: boolean,
): ExportRow[] {
  return rows.filter(r => {
    if (!r.include) {
      return false;
    }
    const state = stateOf(r.objectId);
    return state === 'tracked' || (includeStale && state === 'stale');
  });
}

/** What is wrong with the form, one message per problem; empty when it can be sent. */
export function exportProblems(rows: ReadonlyArray<ExportRow>, options: ExportOptions): string[] {
  const problems: string[] = [];
  if (options.outDir.trim() === '') {
    problems.push('Choose a folder to export to.');
  }
  if (rows.length === 0) {
    problems.push('Pick at least one tracked object.');
  }
  const seen = new Map<string, number>();
  for (const r of rows) {
    const name = `Object ${r.objectId + 1}`;
    if (!PRODUCT_ID.test(r.id)) {
      problems.push(`${name}: the product id may hold only letters, digits, _ and -, and starts with a letter or digit.`);
    }
    if (!COLOR.test(r.color)) {
      problems.push(`${name}: the colour must be #rrggbb.`);
    }
    const other = seen.get(r.id);
    if (other != null) {
      problems.push(`Object ${other + 1} and ${name} share the product id "${r.id}".`);
    } else {
      seen.set(r.id, r.objectId);
    }
  }
  return problems;
}

export function toExportObjects(rows: ReadonlyArray<ExportRow>): ExportObjects {
  const out: ExportObjects = {};
  for (const r of rows) {
    out[String(r.objectId)] = {id: r.id, prompt: r.prompt.trim() || r.id.replace(/_/g, ' '), color: r.color};
  }
  return out;
}
