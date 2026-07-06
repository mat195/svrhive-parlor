# svrhive-parlor — the Parlor

Mat's private command room for SVRHIVE / Silk V1. Login-gated on his own domain
(`hive.silkvelvetrecords.com`). Reads Silk's morning brief, browses the ledger,
approves/rejects queue items, and chats with Silk — grounded in ledger data.

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
3. **Queue** — `action_queue` items with status chips + Silk's rationale +
   attached `drafts`. Approve/Reject writes status + timestamp + optional note.
   **Approving records the decision; it does NOT execute anything** (execution is
   the Corpus Foundry brief).
4. **Silk** — streamed chat. Each reply shows a **sources** line listing the
   ledger rows/runs that informed it. Prefix `/deep` for the stronger model.
   Silk refuses to invent when the ledger lacks the answer (provenance applies).

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
