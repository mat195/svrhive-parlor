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

## STANDING RULE: fix the SOURCE, never hand-patch a generated/published file (Claude 2 + Claude Code)

Every public artifact on silkvelvetrecords.com is GENERATED from a source. Editing the
generated file directly — without updating its source — is a ticking regression: the next
build/publish regenerates from the (still-stale) source and silently reverts your fix.
This has bitten us **twice**: (1) approved facts never reached the site; (2) the site file
was hand-corrected but the underlying draft was left stale, so the next publish reverted it.

The two pipelines and their SOURCES (fix here, then regenerate — do not patch the output):
- **Corpus `/notes/` pages** ← `corpus_drafts.markdown_body` (DB) → `foundry-publish` writes
  `svrhive-site/src/content/notes/<filename>.md`. To change a live note: edit the DRAFT, then
  republish. Never edit the `.md` directly (a republish reverts it). Watch for DUPLICATE
  drafts per filename — correct the newest published one (that's what republishes).
- **`entity.json`** (artist page, footer, all-page JSON-LD `sameAs`) ← the entity master's
  `## Machine-readable entity` json block → `svrhive-site` prebuild `scripts/sync-entity.mjs`
  regenerates `src/data/entity.json`. NEVER hand-edit `entity.json` (prebuild overwrites it).
  Edit `svrhive/docs/LUCIUS_ENTITY_MASTER.md`, then it regenerates. CI keeps the committed
  entity.json when the master isn't checked out — so also commit the regenerated file.
- **`silk_config.entity_master`** (Silk runtime cache) ← same entity master → `sync_config.mjs`.

Corollary: after ANY correction, verify the SOURCE holds it (query the draft / grep the
master), not just the rendered page. A green live page over a stale source is a landmine.
