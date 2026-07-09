# Changelog

Cross-repo changelog for SVRHIVE / Silk V1 — spans **svrhive-parlor** (Parlor app + Supabase
Edge Functions), **svrhive-site** (Astro → silkvelvetrecords.com), and **svrhive** (entity
master / knowledge base). Commit hashes are in `code`. "Infra" = Supabase-side changes not
captured in git (migrations, function deploys, DB ops, cache syncs).

## 2026-07-08 → 07-09

### 🕷 Proactive Silk: daily briefing + push notifications
Silk now contributes while Mat isn't watching — pushes updates to the floating widget, not just
answers when poked.
- `parlor e31ffbd` **Daily briefing** fn + cron (`daily_briefing`, 10:30 UTC / 6:30am Montréal,
  right after `workshop_initiative`): honest 3-beat morning synthesis (what moved / what's
  stalled / worth 5 min), pushed as a notification + journaled. Smoke-tested live.
- `parlor e31ffbd` `silk_notifications` table (owner-RLS) + `notify()` helper (dedupe window)
- `parlor e31ffbd` **Proactive triggers**: battery-complete (DB trigger w/ mention delta,
  catches externally-run batteries), gate-blocked (foundry-publish), resolved-stall +
  needs-Mat give-up (silk-executor)
- `parlor e31ffbd` Widget: unread `fab-badge` + realtime-subscribed notifications panel
- Infra: **cron audit** — all named jobs verified live (Question Hunter = `workshop_initiative`
  daily, `weekly_consolidator` Sun, `catalog_label_sweep` hourly, grants Mon, etc.); dropped
  duplicate untracked `executor_sweeper` (kept Vault-based `silk_executor_sweep`)
- Verified already-shipped: hybrid retrieval + prompt caching (silk-chat `cache_control` +
  journal recency×source scoring); `query_database` reads all 41 public objects (nothing walled off)

### 🔴 Trust-critical: approval → execution gap
Approved corrections were logging to `entity_facts` but never reaching the live site.
- `parlor 9d9da1f` Fix approval→execution gap: verify-before-done + reliability backstop
- `parlor 640da51` silk-executor sweep: filter on `created_at` (phantom `updated_at` column bug)
- `parlor 23d0395` **Standing rule** (CLAUDE.md): fix the SOURCE, never hand-patch generated/published files
- `site 23c9e4e` Fix stuck fact corrections not propagated to live site (activeSince 2016, drop Excelente-Daxsen, drop Sunnie framing)
- `svrhive 9fa1294` Entity master: activeSince 2014→2016; drop Sunnie from bios
- **Infra:** migration `0032` (dispatch trigger widened + `silk_executor_sweep` cron); redeployed `silk-executor`; drained ~24 stalled queue items; appended authoritative `activeSince=2016` fact; one malformed item held on an honest error.

### 🧹 Data-integrity sweeps
- **Bandcamp (full purge)** — LPT has no Bandcamp presence. `site 42aeb76` (entity.json links + bio + footer) + 7 corpus republishes; `svrhive 49dcd1a` (entity master §5, sameAs, bios). Also removed from the Silk cache and the MusicBrainz kit step. MusicBrainz flagged for manual check — verified already clean.
- **Official website** — `svrhive 33725b7` + `site 60fde46`: the fabricated/dead `luciuspthundercat.com` (a prefill assumption, never resolved) → real `silkvelvetrecords.com`.
- **Instagram** — `svrhive 29869dd` + `site 35a224a` + `parlor 17febdf`: added Mat-verified, propagated to sameAs / Press Kit / artist page / llms.txt / Brain snapshot.
- **§5 link graph** — `svrhive d14c780`: every link resolve-checked (HTTP + title/identity match); honest verification note replacing the unreliable "verified 2026-07-06" pass.
- **Feature appearances** — `svrhive 0748586` + `site 1d57091` + `c9555a5`: LPT's featured-on tracks (Love You/Leave You, Forbidden Fruit, Boy Genius, Subconscious) no longer surfaced. `sync-entity.mjs` strips `role: "featured"` (with a `promote: true` escape hatch); 4 release pages 301'd to the artist page; Silk's 2 proposals rejected; behaviorally verified Silk now declines to re-propose them.

### ✨ New Parlor features
- `parlor 0db0f17` **Opportunity Finder — Grants module** (weekly harvester of FACTOR / Musicaction / SOCAN Foundation / CALQ / Canada Council; fit/maybe/not-eligible screening; Workshop → Grants tab). **Infra:** migration `0031`, deployed `grant-harvest`.
- `parlor c213277` **Collaborator Directory** (new People room), **Catalog Manager** (Ledger tab), **Brain six rings** — all read-only views over existing tables.
- `parlor 8705513` **Brief redesign** — split Zone 1 (campaign health) from Zone 2 (system health, collapsed by default, auto-expands on issues).
- `parlor a66a7ba` Fix **Revise-with-note** feedback — visible loading/success/error + diff refresh.
- `parlor b222cba` **Workshop editing** — faithful live rendered preview (iframe using the real site's CSS/typography) + **"Discuss this draft" → Silk chat** with the draft pinned as context + new `revise_draft` tool so Silk applies an agreed change through the normal pipeline. **Infra:** deployed `silk-chat`; tested end-to-end (context injection + tool-firing on agreement).

### 🎨 Site / UX
- `site aae7d1c` **Cover click = inline Spotify play** everywhere except /listen/ (the vinyl ceremony stays exclusive to the Listening Room).
- `site 56d0146` Typography → **Instrument Serif** display face (off the generic serif).
- `site b662667` Canonicalize the study-playlist slug (`list-10-…`); 301 the duplicate; rejected 1 stale duplicate discography draft.
- `parlor 0368716` + `49e84c2` Legible **toasts** — name the filed query / the created draft slug.
- Earlier-evening polish: `site 93ae6e8` Deep Velvet depth pass + crate cohesion; `d3d2e66` hide corpus collective volume; `b628f69`/`d656a90`/`e619f0f` featured set + Tokyo Drift cover + Listening Room rich list.

### Totals
Parlor **13 commits** · site **~30 commits** (incl. ~18 Parlor-triggered corpus republishes) · svrhive **6 commits**. Plus non-git infra: **2 migrations** (`0031`, `0032`), **4 functions deployed** (`grant-harvest`, `silk-executor`, `answer-propagate`, `silk-chat`), multiple DB drains / draft-state fixes / `silk_config` cache re-syncs.
