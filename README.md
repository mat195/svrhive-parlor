# svrhive-parlor — the Parlor

> ## Doctrine — the work happens in the Parlor
> Every SVRHIVE capability defaults to a **Parlor UI** unless there's a
> compelling reason not to. Approval, publishing, editing, monitoring — all
> inside `hive.silkvelvetrecords.com`. No context-switching to GitHub, DNS
> panels, or other tools unless genuinely unavoidable. This is a **design
> constraint**, not a nice-to-have. Silk is the hands; Mat is the will — Silk
> never acts unilaterally, and a Mat click IS the human action.

> ## Doctrine — Realtime never interrupts in-flight input
> Realtime updates in the Parlor never interrupt in-flight user input. Any
> component that both subscribes to Realtime and hosts an input field MUST
> implement the **lock-while-answering** pattern: while an input is focused/active,
> incoming updates are *queued* (shown as "N updates pending"), never applied to
> swap or unmount the input; the lock releases on submit or Escape/Cancel; and any
> typed text auto-saves (localStorage) so nothing is lost. Reference impl:
> `src/components/QuestionsPin.tsx`.

Mat's private command room for SVRHIVE / Silk V1. Login-gated on his own domain
(`hive.silkvelvetrecords.com`). Reads Silk's morning brief, browses the ledger,
approves/rejects queue items, publishes corpus pages, watches for AI referrers,
and chats with Silk — grounded in ledger data.

## Automation boundary — `AUTOPILOT_ALLOWLIST`

Default: **empty** (Silk is read-only to the outside world; `OUTREACH_ENABLED`
false). Brief Three opens exactly **one** scoped door:

```
AUTOPILOT_ALLOWLIST = ["github:svrhive-site:commit-on-approval"]
```

This authorizes Silk to commit to the **`svrhive-site`** repo **only** when Mat
clicks **Publish** or **Retract** in the Parlor UI (via the `foundry-publish` /
`foundry-retract` Edge Functions). No other repo, no other action, **no
unattended writes**. Every other automation door stays closed. The commit is
Mat's decision executed by Silk's hands. It's enforced in code: the publish/
retract functions refuse unless `AUTOPILOT_ALLOWLIST` (a function secret)
contains that exact entry.

## Corpus Foundry — GitHub token setup (Mat does this once)

Publish/Retract commit corpus pages to `svrhive-site`. Until a token is set, the
publish path is **stubbed** (functions return `{stubbed:true}`; nothing is
committed) — everything else works. To enable it, create a token scoped to that
one repo:

- **Preferred — GitHub App:** github.com → Settings → Developer settings → GitHub
  Apps → New. Repository permissions → **Contents: Read and write** (nothing
  else). Install on **only `mat195/svrhive-site`**. Use its installation token.
- **Fallback — fine-grained PAT:** Settings → Developer settings → Fine-grained
  tokens → Repository access: **only `mat195/svrhive-site`** → Permissions →
  **Contents: Read and write** only → generate.

Hand the token to the builder (or run it yourself):

```bash
supabase secrets set GITHUB_TOKEN=<token> --project-ref fitpvesrrirezbndkelo
```

The token lives **only** as a Supabase Edge Function secret — never in a repo or
the frontend bundle (CI greps for it).

**Live now (preview):** https://mat195.github.io/svrhive-parlor/ — sign in with
the owner email's magic link. Moves to `hive.silkvelvetrecords.com` once DNS +
domain verification are done (see below).

## Architecture

```
Browser (React, anon key only)
   │  magic-link auth (Supabase) — owner email only, signups disabled
   │  reads ledger via anon key + RLS (email-scoped policies)
   │  POST /functions/v1/silk-chat  (user JWT)
   ▼
Supabase (existing SVRHIVE project: fitpvesrrirezbndkelo)
   ├─ Postgres + RLS: every table visible ONLY to the owner's authenticated JWT.
   │   Anon with no session = zero rows on every table.
   └─ Edge Function silk-chat (service role): verifies owner → gathers ledger
      context → calls Anthropic (key is a function secret) → streams reply →
      persists assistant message with ledger_refs.
```

**Secret flow (Foundation Rule 4).** The browser bundle contains ONLY the
Supabase URL + anon key (both public; protected by RLS). The service key and the
Anthropic key live exclusively in Supabase (Edge Function secrets). CI greps the
bundle to enforce this (`npm run check:secrets`).

## Views (v1)

1. **Brief** (home) — latest battery run: score + trend delta, per-category bars,
   top competitors, top cited domains, latest journal, latest metric snapshot.
2. **Ledger** — tabbed browser (results / runs / journal / mentions / metrics),
   filters (category / engine / mentioned), recent-first, load-more.
3. **Workshop** — three subtabs. **Drafts** = Corpus Foundry: Silk drafts corpus
   pages (or type a target query to generate one); each Draft Card has
   Preview / Edit / Details modes and Publish (3s confirm) / Reject / Regenerate;
   published cards show live URL + visits + citing-prompt count and a **Retract**
   button for 15 minutes. **Actions** = the `action_queue` (approve/reject records
   the decision; never auto-executes). **Listings** = guided submission wizards
   (MusicBrainz artist/label/releases, Wikidata artist/label) generated from the
   entity master — order-enforced, per-field copy buttons + "open submission page"
   links, resumable progress. A **Listing Sprint** readiness gate says "ready" only
   once all five wizards are live. Regenerate wizards: `node scripts/gen_listing_wizards.mjs` (svrhive).
4. **Silk** — streamed chat. Each reply shows a **sources** line listing the
   ledger rows/runs that informed it. Prefix `/deep` for the stronger model.
   Silk refuses to invent when the ledger lacks the answer (provenance applies).
5. **Watchtower** — Referrer Watch: today/7d/30d visit counters, referrer
   breakdown (AI referrers pinned), live feed, and the permanent **first-AI-visitor
   trophy**. Discord pings on the first AI referrer of each day.

## Security model

- **Auth:** Supabase magic link, `shouldCreateUser: false`, public **signups
  disabled**, owner email pre-created and allowlisted. A second email fails
  cleanly. Verified: `npm run verify:rls` (anon-no-session = 0 rows on every
  table; non-owner OTP rejected).
- **RLS:** `public.is_parlor_owner()` = `auth.jwt() email == owner`. Every table
  grants SELECT (and action_queue UPDATE, parlor_* INSERT) only when true. No
  anon policies anywhere.
- **Edge Function:** verifies the caller's JWT email == owner (401 otherwise),
  rate-limited per minute, `max_tokens` capped.

## Commands

```bash
npm install
npm run dev            # local (uses .env VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)
npm run build          # tsc + vite → dist/
npm run check:secrets  # fail if any service/LLM key is in src or dist
npm run verify:rls     # anon=0-rows on every table + non-owner sign-in blocked
```

Deploy env in CI: repo **variables** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.

## Adding a view

1. Create `src/views/MyView.tsx` (fetch with the `supabase` client — RLS scopes it).
2. Add it to the `TABS` array + render switch in `src/App.tsx`.
3. Style with the existing tokens in `src/styles.css`.

## Edge Function

`supabase/functions/silk-chat/` — `index.ts` + `identity.ts` (Silk's persona,
bundled). Deploy + secret:

```bash
supabase functions deploy silk-chat --project-ref fitpvesrrirezbndkelo
supabase secrets set ANTHROPIC_API_KEY=... --project-ref fitpvesrrirezbndkelo
```

## DNS — moving to hive.silkvelvetrecords.com

The custom domain is deferred because GitHub blocks a **second** repo from using a
subdomain of `silkvelvetrecords.com` (claimed by `svrhive-site`) until the domain
is **verified at the account level**. Two steps for Mat:

1. **Verify the domain:** github.com → Settings → Pages → **Add a domain** →
   `silkvelvetrecords.com` → add the `TXT` record GitHub shows
   (`_github-pages-challenge-mat195...`) at your registrar → Verify.
2. **Point the subdomain:**

   | Type | Host | Value |
   |------|------|-------|
   | CNAME | hive | `mat195.github.io.` |

Then tell the builder (or, in this repo: restore `public/CNAME` =
`hive.silkvelvetrecords.com` and set the Pages custom domain). HTTPS auto-issues.
The bundle uses a **relative base**, so it works at the preview path and the
custom-domain root without changes.

## Stack

Vite + React (static). Supabase (auth, Postgres/RLS, Edge Functions). GitHub
Pages. `noindex` (private tool).
