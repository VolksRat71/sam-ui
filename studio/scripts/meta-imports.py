# sam-ui (Apache-2.0). New file, not from SAM 2.
"""List the files studio reaches through the "@/" alias (studio/src/meta, the
Meta demo code studio vendors), walking every import from studio/src,
type-only ones included (tsc needs those files too).

    python3 studio/scripts/meta-imports.py          # list them, with the importer
    python3 studio/scripts/meta-imports.py --unused # vendored files nothing reaches

Run it after changing what studio imports: a file listed by --unused can go.
"""
import os
import re
import sys

STUDIO = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src')
STUDIO = os.path.normpath(STUDIO)
META = os.path.join(STUDIO, 'meta')
IMPORT = re.compile(
    r"""(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]"""
    r"""|import\(\s*['"]([^'"]+)['"]\s*\)|new URL\(\s*['"]([^'"]+)['"]""",
    re.S,
)
EXTS = ['', '.ts', '.tsx', '.d.ts', '/index.ts', '/index.tsx', '/index.d.ts']
# resolved through tsconfig "paths", not an import path
EXTRA = ['types/mp4box/index.d.ts']


def resolve(frm, spec):
    base = spec.split('?')[0]
    if base.startswith('@/'):
        p = os.path.join(META, base[2:])
    elif base.startswith('~/'):
        p = os.path.join(STUDIO, base[2:])
    elif base.startswith('.'):
        p = os.path.normpath(os.path.join(os.path.dirname(frm), base))
    else:
        return None  # a package
    for e in EXTS:
        if os.path.isfile(p + e):
            return p + e
    raise SystemExit(f'unresolved import {spec!r} in {frm}')


def reached():
    seen, why = set(), {}

    def walk(f, via):
        if f in seen:
            return
        seen.add(f)
        why[f] = via
        if f.endswith(('.ts', '.tsx')):
            for m in IMPORT.finditer(open(f, encoding='utf-8').read()):
                r = resolve(f, m.group(1) or m.group(2) or m.group(3))
                if r is not None:
                    walk(r, f)

    for root, dirs, files in os.walk(STUDIO):
        dirs[:] = [d for d in dirs if d not in ('meta', '__generated__')]
        for n in files:
            if n.endswith(('.ts', '.tsx')):
                walk(os.path.join(root, n), 'studio')
    for e in EXTRA:
        walk(os.path.join(META, e), 'tsconfig paths')
    return {f: v for f, v in why.items() if f.startswith(META + os.sep)}


if __name__ == '__main__':
    got = reached()
    if '--unused' in sys.argv:
        for root, _, files in os.walk(META):
            for n in files:
                f = os.path.join(root, n)
                if f not in got:
                    print(os.path.relpath(f, META))
    else:
        for f in sorted(got):
            v = got[f]
            print(os.path.relpath(f, META), '<-', v if v in ('studio', 'tsconfig paths') else os.path.relpath(v, STUDIO))
        print(len(got), 'files')
