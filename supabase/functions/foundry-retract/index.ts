// foundry-retract — within 15 min of publish, deletes the note file from
// svrhive-site/main and marks the draft retracted. Owner-only + allowlist-gated.
// After 15 min the window is closed (button hidden in the UI; documented manual
// path only). No token → clean stub.
import { admin, requireOwner, json, CORS } from '../_shared/auth.ts';

const REPO = 'mat195/svrhive-site';
const ALLOW_ENTRY = 'github:svrhive-site:commit-on-approval';
const WINDOW_MS = 15 * 60 * 1000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const auth = await requireOwner(req);
  if (!auth.ok) return auth.res;

  const allow = (Deno.env.get('AUTOPILOT_ALLOWLIST') ?? '').split(',').map((s) => s.trim());
  if (!allow.includes(ALLOW_ENTRY)) return json({ error: 'commit not authorized by AUTOPILOT_ALLOWLIST' }, 403);

  let body: { draft_id?: string };
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  if (!body.draft_id) return json({ error: 'draft_id required' }, 400);

  const { data: draft, error: dErr } = await admin.from('corpus_drafts').select('*').eq('id', body.draft_id).single();
  if (dErr || !draft) return json({ error: 'draft not found' }, 404);
  if (draft.status !== 'published') return json({ error: 'draft is not published' }, 400);

  const publishedMs = draft.published_at ? Date.parse(draft.published_at) : 0;
  if (!publishedMs || Date.now() - publishedMs > WINDOW_MS) {
    return json({ error: 'retract window (15 min) expired — use a manual edit/delete flow' }, 400);
  }

  const token = Deno.env.get('GITHUB_TOKEN');
  if (!token) return json({ stubbed: true, error: 'GITHUB_TOKEN not configured — retract path stubbed.' }, 200);

  const path = `src/content/notes/${draft.filename}`;
  const ghHeaders = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' };

  const existing = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, { headers: ghHeaders });
  if (!existing.ok) return json({ error: 'note file not found on repo (already gone?)' }, 404);
  const sha = (await existing.json()).sha;

  const del = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'DELETE',
    headers: ghHeaders,
    body: JSON.stringify({ message: `Retract corpus note: ${draft.target_query} (via Parlor)`, sha, branch: 'main' }),
  });
  if (!del.ok) return json({ error: `github delete failed: ${del.status} ${(await del.text()).slice(0, 200)}` }, 502);

  const now = new Date().toISOString();
  // Distinguish a retract past the 15-min window (recorded for later review).
  const afterWindow = (body as { after_window?: boolean }).after_window === true;
  const note = afterWindow ? 'retracted_after_window' : null;
  await admin.from('corpus_drafts').update({ status: 'retracted', retracted_at: now, updated_at: now, ...(note ? { mat_note: note } : {}) }).eq('id', draft.id);
  if (afterWindow) await admin.from('silk_journal').insert({ entry: `Corpus page retracted PAST the 15-min window: "${draft.target_query}" (${draft.live_url}). Recorded as retracted_after_window.`, tags: ['corpus', 'retract', 'after-window'] });
  return json({ ok: true, retracted_at: now, after_window: afterWindow });
});
