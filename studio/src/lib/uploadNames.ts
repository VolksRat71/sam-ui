// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The backend names an upload by its content hash; the file name the user
// picked is remembered here (per browser), for the Media list and for the
// names exports start from.
import {readJson, writeJson} from './storage';

const KEY = 'sam-ui-studio:upload-names';

export function rememberUploadName(path: string, name: string): void {
  writeJson(KEY, {...readJson<Record<string, string>>(KEY, {}), [path]: name});
}

/** The video's name to show: the uploaded file's own name when known, else its path's file name. */
export function videoDisplayName(path: string): string {
  return readJson<Record<string, string>>(KEY, {})[path] ?? path.split('/').pop() ?? path;
}
