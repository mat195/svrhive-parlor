// foundry-publish — commits a corpus draft to svrhive-site/main. Fires ONLY on
// Mat's Publish click (owner-verified) AND only if AUTOPILOT_ALLOWLIST authorizes
// the scoped door. No token configured → clean stub (nothing committed).
import { admin, requireOwner, json, CORS } from '../_shared/auth.ts';
import { provenanceIssues } from '../_shared/provenance.ts';
import { notify } from '../_shared/notify.ts';

const REPO = 'mat195/svrhive-site';
const ALLOW_ENTRY = 'github:svrhive-site:commit-on-approval';

function b64(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

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

  // PROVENANCE GATE (Foundation Rule): block the commit if the draft would fail the
  // site's provenance lint. Runs BEFORE any GitHub write, so bad content never reaches
  // the repo — not caught late at CI. Every publish passes through here (only committer).
  const issues = provenanceIssues(draft.markdown_body ?? '');
  if (issues.length) {
    await admin.from('silk_journal').insert({
      entry: `[gate] Publish BLOCKED for ${draft.filename} (${draft.id}) — provenance: ${issues.join('; ')}. Nothing committed.`,
      tags: ['gate', 'provenance', 'publish-blocked'],
    });
    // Push it — a publish can be triggered from chat/automation where Mat isn't watching the response.
    await notify({ kind: 'gate-blocked', title: `Publish blocked: ${draft.target_query ?? draft.filename}`.slice(0, 80), body: `The provenance gate stopped it: ${issues.join('; ')}. Nothing was committed — fix the draft (Quick Edit / Revise) and try again.`, url: '#/workshop', priority: 'high' });
    return json({ ok: false, blocked: true, error: `Publish blocked by provenance gate: ${issues.join('; ')}. Fix the draft (Quick Edit / Revise) and try again.`, issues }, 422);
  }

  const token = Deno.env.get('GITHUB_TOKEN');
  if (!token) {
    return json({ stubbed: true, error: 'GITHUB_TOKEN not configured — publish path stubbed. Draft not committed.' }, 200);
  }

  const path = `src/content/notes/${draft.filename}`;
  const ghHeaders = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' };

  // If the file already exists, include its sha (update instead of create).
  let sha: string | undefined;
  const existing = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, { headers: ghHeaders });
  if (existing.ok) sha = (await existing.json()).sha;

  const put = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: ghHeaders,
    body: JSON.stringify({
      message: `Publish corpus note: ${draft.target_query} (via Parlor)`,
      content: b64(draft.markdown_body ?? ''),
      branch: 'main',
      ...(sha ? { sha } : {}),
    }),
  });
  if (!put.ok) return json({ error: `github commit failed: ${put.status} ${(await put.text()).slice(0, 200)}` }, 502);
  const commit = await put.json();
  const commitSha = commit?.commit?.sha ?? null;

  const publishedAt = new Date().toISOString();
  await admin.from('corpus_drafts').update({
    status: 'published', commit_sha: commitSha, published_at: publishedAt, updated_at: publishedAt,
  }).eq('id', draft.id);

  return json({ ok: true, commit_sha: commitSha, live_url: draft.live_url, note: 'CI build will make it live in ~1-2 min.' });
});
