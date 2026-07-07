// foundry-generate — Silk drafts a corpus page targeting an LPT-visibility query,
// per skills/corpus-page-spec.md. Saves a `proposed` corpus_drafts row. Nothing
// publishes. Owner-only.
import { admin, requireOwner, json, CORS } from '../_shared/auth.ts';
import { startStatus, endStatus } from '../_shared/status.ts';
import { verifyWrite } from '../_shared/silk.ts';
import { buildSystemPrompt } from '../_shared/prompt_builder.ts';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;
const MODEL = 'claude-haiku-4-5-20251001';

const SPEC = `You spec answer-engine-winning pages for the RAPPER AND VOCALIST "Lucius P. Thundercat" (never a producer; never abbreviate the name). Rules from corpus-page-spec.md:
- H1 = the target question. First 1-2 sentences answer it completely and self-containedly.
- Every page targets an LPT-visibility query. NEVER a label-visibility page.
- Only entity-master-backed facts. If unknown, omit — never invent. Include the disambiguation ("not affiliated with Thundercat / Stephen Bruner") where the clash is plausible.
- Include a machine-readable table where the answer has structured facts.
- A human who searched this query should thank us for this page.`;

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const auth = await requireOwner(req);
  if (!auth.ok) return auth.res;

  let body: { target_query?: string };
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const targetQuery = (body.target_query ?? '').trim();
  if (!targetQuery) return json({ error: 'target_query required' }, 400);
  const statusId = await startStatus('working', 'drafting a corpus page', 'foundry-generate', targetQuery);

  // Pull competitor URLs the query currently cites, from the ledger.
  const kws = targetQuery.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 4).slice(0, 5);
  let competitorUrls: string[] = [];
  let latestRunId: string | null = null;
  const { data: runs } = await admin.from('visibility_runs').select('id').order('run_at', { ascending: false }).limit(1);
  latestRunId = runs?.[0]?.id ?? null;
  if (kws.length) {
    const ors = kws.map((k) => `prompt.ilike.%${k}%`).join(',');
    const { data } = await admin.from('visibility_results').select('citations').or(ors).limit(20);
    const set = new Set<string>();
    for (const r of data ?? []) for (const u of (r.citations as string[]) ?? []) set.add(u);
    competitorUrls = [...set].slice(0, 12);
  }

  // Ask Claude for the page (body only; we build frontmatter). Five-layer assembly
  // (Brief Seven) — L3 auto-loads corpus-page-spec + schema-markup + format-for-human.
  const built = await buildSystemPrompt({
    surface: 'foundry-generate', message: targetQuery, callId: targetQuery, taskTypeHint: 'corpus_draft',
    ledgerSnapshot: `Competitor URLs currently winning "${targetQuery}": ${competitorUrls.join(', ') || 'none found in ledger'}`,
  });
  const identityHash = built.identityHash;
  const system = built.system + '\n\n--- CORPUS PAGE OUTPUT SPEC ---\n' + SPEC + '\nOutput ONLY minified JSON, no prose, no code fences.';
  const user =
    `Target query: "${targetQuery}".\nCompetitor URLs currently winning this space: ${competitorUrls.join(', ') || 'none found in ledger'}.\n` +
    'Produce JSON: {"title":string (<=70 chars, the question as a title),"description":string (<=160 chars, the direct answer),"body_markdown":string (the full page body in markdown: H1 as the question, direct answer first, a table if useful, short sections; NO frontmatter),"silk_explains":string (one sentence, Silk voice, why publishing this helps),"rationale":string (2-3 sentences: which query, who wins it now, expected outcome)}';

  // Robust JSON extraction: strip fences, take the outer {...}.
  const parseGen = (text: string) => {
    const s = (text ?? '').replace(/^```(?:json)?/im, '').replace(/```\s*$/m, '').trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('no JSON object in model output');
    return JSON.parse(s.slice(a, b + 1));
  };
  const anthropicJSON = async (): Promise<string> => {
    let delay = 1000;
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, max_tokens: built.maxTokens, system, messages: [{ role: 'user', content: user }], stop_sequences: [] }),
      });
      if (res.status === 429 || res.status === 529) { await new Promise((r) => setTimeout(r, delay)); delay = Math.min(delay * 2, 16000); continue; }
      const data = await res.json();
      return (data?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    }
    return '';
  };

  // Direct single-shot generation (no tools — reliable JSON) with a parse-retry.
  let gen: { title: string; description: string; body_markdown: string; silk_explains: string; rationale: string } | null = null;
  let lastErr = '';
  for (let attempt = 1; attempt <= 3 && !gen; attempt++) {
    try { gen = parseGen(await anthropicJSON()); } catch (e) { lastErr = e instanceof Error ? e.message : String(e); }
  }
  if (!gen) { await endStatus(statusId, false); return json({ error: `generation failed (no valid JSON after 3 attempts): ${lastErr}` }, 500); }

  const slug = slugify(gen.title || targetQuery);
  const filename = `${slug}.md`;
  const canonical = `https://silkvelvetrecords.com/notes/${slug}/`;
  const frontmatter = [
    '---',
    `title: ${JSON.stringify(gen.title)}`,
    `description: ${JSON.stringify(gen.description)}`,
    `targetQuery: ${JSON.stringify(targetQuery)}`,
    `canonical_url: ${JSON.stringify(canonical)}`,
    'draft: false',
    '---',
    '',
  ].join('\n');
  const markdown_body = frontmatter + (gen.body_markdown ?? '');

  const { data: draft, error } = await admin.from('corpus_drafts').insert({
    target_query: targetQuery,
    competitor_urls: competitorUrls,
    rationale: gen.rationale ?? null,
    silk_explains: gen.silk_explains ?? null,
    filename,
    markdown_body,
    status: 'proposed',
    live_url: canonical,
    ledger_refs: latestRunId ? [{ kind: 'visibility_run', id: latestRunId }] : [],
  }).select('*').single();
  if (error) { await endStatus(statusId, false); return json({ error: error.message }, 500); }

  // Voice-not-hands: confirm the draft actually landed before reporting done.
  const proof = await verifyWrite('corpus_drafts', { id: draft.id });
  if (!proof.ok) { await endStatus(statusId, false); return json({ error: 'draft insert unverified: ' + proof.detail }, 500); }

  await endStatus(statusId, true);
  return json({ ok: true, draft, identity_hash: identityHash, write_proof: proof.detail });
});
