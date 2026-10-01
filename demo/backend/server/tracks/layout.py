# sam-ui (Apache-2.0). New file, not from SAM 2.
"""The object layout (issue #21): the order of a video's objects and their
groups, in <root>/<video>/layout.json, next to the object directories:

    {"order": [obj_id, ...],
     "groups": [{"id", "name", "color", "members": [obj_id, ...], "collapsed", "hidden"}]}

The order is the Objects list's, the timeline lanes' and every export's. A
group is a named, coloured set of objects; an object is in at most one.
"collapsed" folds the group in the list, "hidden" keeps its masks off the
preview (never off an export).

Like object.json, the layout is metadata: it is in no object's seed record
(SeedStore.RECORD_FILES), so no reorder or regroup changes a seeds hash,
makes a track stale or goes on an object's undo history.

A video with no layout.json (every video from before layouts) keeps creation
order, which is id order (ids are never reused), and has no groups. A damaged
file reads the same way.

What is stored is what studio sent, validated: it may name objects not
clicked yet (studio saves as you arrange). What is read is arranged against
the objects that exist (arrange()): unknown ids dropped, objects the layout
does not name appended in creation order, and each group's members together
at the place of its first member, so the order is exactly the list as shown.
Removing an object takes it out of the stored layout too.
"""
import json
import os
import re
from pathlib import Path
from typing import Dict, Iterable, List, Optional

GROUP_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
COLOR_RE = re.compile(r"#[0-9a-fA-F]{6}")
NAME_MAX = 64
DEFAULT_NAME = "Group"

Layout = Dict[str, list]


class LayoutError(ValueError):
    pass


def empty() -> Layout:
    return {"order": [], "groups": []}


def _ids(raw, what: str) -> List[int]:
    if not isinstance(raw, list) or any(isinstance(o, bool) or not isinstance(o, int) for o in raw):
        raise LayoutError(f"{what} must be a list of object ids")
    return list(dict.fromkeys(int(o) for o in raw))


def clean(raw) -> Layout:
    """A layout as sent, validated (LayoutError otherwise): ids deduplicated,
    names trimmed and capped (empty: "Group"), and each object kept only in
    the first group that names it."""
    if not isinstance(raw, dict):
        raise LayoutError("the layout must be an object")
    order = _ids(raw.get("order", []), "order")
    groups_raw = raw.get("groups", [])
    if not isinstance(groups_raw, list):
        raise LayoutError("groups must be a list")
    groups, seen_ids, taken = [], set(), set()
    for g in groups_raw:
        if not isinstance(g, dict):
            raise LayoutError("each group must be an object")
        gid = g.get("id")
        if not isinstance(gid, str) or not GROUP_ID_RE.fullmatch(gid):
            raise LayoutError(f"group id {gid!r} must be letters, digits, '_' or '-'")
        if gid in seen_ids:
            raise LayoutError(f"two groups have the id {gid!r}")
        seen_ids.add(gid)
        color = g.get("color")
        if not isinstance(color, str) or not COLOR_RE.fullmatch(color):
            raise LayoutError(f"group {gid}: colour must be #rrggbb, got {color!r}")
        name = g.get("name")
        name = (name if isinstance(name, str) else "").strip()[:NAME_MAX].strip() or DEFAULT_NAME
        members = [m for m in _ids(g.get("members", []), f"group {gid}'s members") if m not in taken]
        taken.update(members)
        groups.append({"id": gid, "name": name, "color": color.lower(), "members": members,
                       "collapsed": bool(g.get("collapsed")), "hidden": bool(g.get("hidden"))})
    return {"order": order, "groups": groups}


def arrange(layout: Layout, objects: Iterable[int]) -> Layout:
    """The layout against the objects that exist (see the module doc)."""
    known = sorted(set(int(o) for o in objects))
    have = set(known)
    order = [o for o in layout["order"] if o in have]
    listed = set(order)
    order += [o for o in known if o not in listed]
    rank = {o: i for i, o in enumerate(order)}
    groups = [{**g, "members": sorted((m for m in g["members"] if m in have), key=rank.__getitem__)}
              for g in layout["groups"]]
    group_of = {m: g for g in groups for m in g["members"]}
    flat, placed = [], set()
    for o in order:
        g = group_of.get(o)
        if g is None:
            flat.append(o)
        elif g["id"] not in placed:
            placed.add(g["id"])
            flat.extend(g["members"])
    return {"order": flat, "groups": groups}


def without_object(layout: Layout, obj_id: int) -> Layout:
    return {"order": [o for o in layout["order"] if o != obj_id],
            "groups": [{**g, "members": [m for m in g["members"] if m != obj_id]} for g in layout["groups"]]}


def without_group(layout: Layout, group_id: str) -> Layout:
    """Delete a group; its members stay where they are, ungrouped."""
    return {"order": list(layout["order"]), "groups": [g for g in layout["groups"] if g["id"] != group_id]}


class LayoutStore:
    def __init__(self, root: str):
        self.root = Path(root)

    def _path(self, video: str) -> Path:
        return self.root / video / "layout.json"

    def stored(self, video: str) -> Optional[Layout]:
        """The layout as stored, or None (none yet, or unreadable)."""
        try:
            return clean(json.loads(self._path(video).read_text()))
        except (OSError, ValueError):
            return None

    def get(self, video: str, objects: Iterable[int]) -> Layout:
        return arrange(self.stored(video) or empty(), objects)

    def set(self, video: str, raw) -> Layout:
        layout = clean(raw)
        p = self._path(video)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_text(json.dumps(layout, indent=1))
        os.replace(tmp, p)
        return layout

    def remove_object(self, video: str, obj_id: int) -> None:
        layout = self.stored(video)
        if layout is not None:
            self.set(video, without_object(layout, int(obj_id)))
