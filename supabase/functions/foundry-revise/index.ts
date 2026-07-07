// foundry-revise (Workshop collaboration) — Mat directs a draft in plain language;
// Silk rewrites it against the note + the corpus rulebook and stores a new version.
// Mat never edits markdown. Owner-only.
import { admin, requireOwner, json, CORS } from '../_shared/auth.ts';
import { loadIdentity, loadConfig, verifyWrite } from '../_shared/silk.ts';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;
const MODEL = 'claude-sonnet-4-6';
const stripFm = (md: string) => (md || '').replace(/^---[\s\S]*?---\n?/, '');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const auth = await requireOwner(req);
  if (!auth.ok) return auth.res;
  let body: { draft_id?: string; note?: string };
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  if (!body.draft_id || !body.note?.trim()) return json({ error: 'draft_id + note required' }, 400);

  const { data: draft } = await admin.from('corpus_drafts').select('*').eq('id', body.draft_id).maybeSingle();
  if (!draft) return json({ error: 'draft not found' }, 404);

  const { identity } = await loadIdentity();
  const spec = (await loadConfig('skill:corpus-page-spec')).value;
  const system = identity + '\n\n--- CORPUS PAGE SPEC ---\n' + spec +
    '\n\n--- REVISE TASK ---\nRevise the draft below per Mat\'s note, keeping every corpus rule (curator voice, no CTA, disambiguation never in prose, do-not-name low-audience co-artists, [MAT: …] placeholders preserved unless the note fills them). ' +
    'Output ONLY minified JSON, no fences: {"body_markdown": string (the FULL revised body, no frontmatter), "changed_summary": string (1-2 lines: what changed), "title": string (unchanged unless the note asks), "description": string}';
  const user = `Mat's revision note: "${body.note}"\n\nCURRENT DRAFT (target query: "${draft.target_query}"):\n${stripFm(draft.markdown_body ?? '')}`;

  const parse = (t: string) => { const s = (t ?? '').replace(/^```(?:json)?/im, '').replace(/```\s*$/m, '').trim(); const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a < 0 || b <= a) throw new Error('no JSON'); return JSON.parse(s.slice(a, b + 1)); };
  let gen: any = null, lastErr = '', delay = 1000;
  for (let attempt = 1; attempt <= 3 && !gen; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 8000, system, messages: [{ role: 'user', content: user }] }),
    });
    if (res.status === 429 || res.status === 529) { await new Promise((r) => setTimeout(r, delay)); delay = Math.min(delay * 2, 16000); continue; }
    const data = await res.json();
    const text = (data?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    try { gen = parse(text); } catch (e) { lastErr = e instanceof Error ? e.message : String(e); }
  }
  if (!gen?.body_markdown) return json({ error: `revision failed (no valid JSON): ${lastErr}` }, 500);

  // Version history: snapshot the PRIOR body, then update the draft.
  const { data: vers } = await admin.from('corpus_draft_versions').select('version').eq('draft_id', draft.id).order('version', { ascending: false }).limit(1);
  const nextV = (vers?.[0]?.version ?? 0) + 1;
  await admin.from('corpus_draft_versions').insert({ draft_id: draft.id, version: nextV, markdown_body: draft.markdown_body });
  const fm = (draft.markdown_body ?? '').match(/^---[\s\S]*?---\n?/)?.[0] ?? '';
  await admin.from('corpus_drafts').update({ markdown_body: fm + gen.body_markdown, status: 'edited', mat_note: body.note, updated_at: new Date().toISOString() }).eq('id', draft.id);

  const proof = await verifyWrite('corpus_draft_versions', { draft_id: draft.id, version: nextV });
  await admin.from('silk_journal').insert({ entry: `Revised draft "${draft.target_query}" v${nextV} per Mat's note: "${body.note}". ${gen.changed_summary ?? ''}`, tags: ['corpus', 'revise', 'collaboration'] });
  return json({ ok: true, version: nextV, changed_summary: gen.changed_summary, write_proof: proof.detail });
});
