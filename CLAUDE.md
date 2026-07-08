# SVRHIVE — working notes for Claude Code

## STANDING CHECK: "landed"/"ready" ≠ committed to the repo (verify first)

When Mat says a file has "landed", is "ready", or was "added/exported" — **do not assume a
chat upload or his local machine means it's in the repo.** Before proceeding, verify the
file actually exists where he says it is:

- Repo files: `ls`/read the exact path, or `git pull` first if it should have been committed.
- DB-backed data: check via `query_database` (silk_config, releases, etc.).

This is the root cause of a recurring gap: three Spotify exports were referenced as
"landed" over successive turns while none were yet committed. Catch it by verifying, then
proceed — or flag the absence and ask Mat to commit, rather than persisting his stated
figures as if independently verified.

Provenance discipline still applies: Mat's stated figures are an allowed source, but say so
explicitly ("Mat-provided, pending file") until you can recompute against the committed
file.

## Data source-of-truth map
- **Complete per-track catalog** = `releases` / `tracks` tables (66 tracks, lifetime streams,
  ISRCs, `tier` 1–4; use `releases_surfaceable` to exclude withdrawn). The entity master §6
  markdown is the curated human-readable subset.
- **Entity master** source = `svrhive/docs/LUCIUS_ENTITY_MASTER.md` → synced to
  `silk_config.entity_master` via `svrhive/scripts/sync_config.mjs`. Edit the file, then sync.
- **Observations** (audience timeline, track streams) = `svrhive/silk_workspace/observations/*.json`
  → synced to `silk_config.observation:*` (queryable by Silk via `query_database`).
- **Raw exports** live in `svrhive/docs/` (DistroKid catalog, Spotify for Artists CSVs).
