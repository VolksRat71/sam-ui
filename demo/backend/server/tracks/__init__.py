# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Per-object tracks: seeds, cached tracks, and the engines that make them.

Each object owns its seeds (the clicks that define it) and, per engine, one
cached track (a mask per frame). A track is "stale" when the seeds, engine or
model it was made from no longer match, so a Track press only has to run the
objects that are untracked or stale.
"""
