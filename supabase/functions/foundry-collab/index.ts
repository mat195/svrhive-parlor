// foundry-collab — the dedicated add/remove-a-named-collaborator workflow for corpus
// pages. The step that ate the most time ("swap these names for those"). Verifies every
// name against §7 (roles) and §6 (features + ISRC/tier) before writing, refuses silently
// if it can't verify (same discipline as the rest of the foundry), and does a SECTION-
// SCOPED revise (regenerates only the "## Notable Collaborations" block) so the diff is
// small and the rest of the page is untouched.
//
//   action: 'list'    → collaborators currently named on the page (+ section)
//   action: 'resolve' → is <name> verifiable? role/track/tier + suggested section, or needs_track
//   action: 'suggest' → autocomplete candidates for a typed prefix (from §7 + §6 features)
//   action: 'add'     → verify <name> (+ optional <track>), insert into the right section (scoped revise)
//   action: 'remove'  → drop <name>, fix surrounding prose (scoped revise)
import { admin, requireOwner, json, CORS } from '../_shared/auth.ts';

const ANTHROPIC = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const SECTION_HEADER = '## Notable Collaborations';

// ---- parse the entity master (authoritative record) ---------------------------------
interface Known { name: string; role?: string; montreal?: boolean; recurring?: boolean; track?: string; isrc?: string; tier?: number }

function parseEntity(em: string): Map<string, Known> {
  const by = new Map<string, Known>();
  const get = (n: string) => { const k = n.toLowerCase(); if (!by.has(k)) by.set(k, { name: n }); return by.get(k)!; };
  // §7 collaborator bullets:  - **Name** (tags) — role
  const s7 = em.slice(em.indexOf('## 7.'), em.indexOf('## 8.') > 0 ? em.indexOf('## 8.') : undefined);
  for (const m of s7.matchAll(/-\s+\*\*([^*]+)\*\*\s*(\([^)]*\))?\s*(?:—\s*(.*))?/g)) {
    const name = m[1].trim(); const tags = (m[2] ?? '').toLowerCase(); const role = (m[3] ?? '').split('.')[0].trim();
    const k = get(name); k.role = role || k.role; k.montreal = /montr/.test(tags) || k.montreal; k.recurring = /recurring/.test(tags) || k.recurring;
  }
  // §6 discography rows:  | Title | ... | feat. A, B | ... | ISRC | (grab feat. names + track + tier hint)
  const s6 = em.slice(em.indexOf('## 6.'), em.indexOf('## 7.'));
  const tier4 = s6.slice(s6.indexOf('Tier 4')); // rows under the Tier-4 subsection
  for (const line of s6.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cols = line.split('|').map((c) => c.trim());
    const title = cols[1]; const feat = cols.find((c) => /^feat\./i.test(c)); const isrc = cols.find((c) => /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(c));
    if (!feat) continue;
    const isTier4 = tier4.includes(line);
    for (const nm of feat.replace(/^feat\.\s*/i, '').split(/,|&/).map((s) => s.trim()).filter(Boolean)) {
      const k = get(nm);
      if (!k.track) { k.track = title; k.isrc = isrc; k.tier = isTier4 ? 4 : 1; }
    }
  }
  return by;
}

function classify(k: Known): 'Montréal scene' | 'Recurring collaborators' | 'Notable features' {
  if (k.montreal) return 'Montréal scene';
  if (k.recurring) return 'Recurring collaborators';
  return 'Notable features';
}

// Names the page currently mentions, from the known set.
function namedOnPage(body: string, known: Map<string, Known>): { name: string; section: string }[] {
  const out: { name: string; section: string }[] = [];
  for (const k of known.values()) {
    if (new RegExp(`\\b${k.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(body)) out.push({ name: k.name, section: classify(k) });
  }
  return out;
}

function sectionSlice(body: string): { before: string; section: string; after: string } | null {
  const s = body.indexOf(SECTION_HEADER);
  if (s === -1) return null;
  const restStart = s + SECTION_HEADER.length;
  const nextH = body.indexOf('\n## ', restStart);
  const end = nextH === -1 ? body.length : nextH;
  return { before: body.slice(0, s), section: body.slice(s, end), after: body.slice(end) };
}

async function anthropicJSON(system: string, user: string): Promise<string> {
  let delay = 1000;
  for (let a = 0; a < 5; a++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': ANTHROPIC, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1500, system, messages: [{ role: 'user', content: user }] }),
    });
    if (res.status === 429 || res.status === 529) { await new Promise((r) => setTimeout(r, delay)); delay = Math.min(delay * 2, 16000); continue; }
    const d = await res.json();
    return (d?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
  }
  return '';
}

const SYS =
  `You edit ONLY the "${SECTION_HEADER}" section of a corpus page for Lucius P. Thundercat. ` +
  'Sub-groups, in order: "**Montréal scene:**", "**Recurring collaborators:**", "**Notable features:**". ' +
  'Apply the single requested change (add or remove one collaborator) and fix surrounding prose so it reads clean — no dangling commas, correct conjunctions. ' +
  'Do NOT invent facts: use only the verified role/track given. Do NOT include withdrawal/tier reasons (internal only). Keep every other collaborator and the group structure intact. ' +
  'Output ONLY the revised section starting with the exact header line — no preamble, no code fences.';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const auth = await requireOwner(req);
  if (!auth.ok) return auth.res;

  let body: any; try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const { draft_id, action, name, track } = body;
  if (!draft_id || !action) return json({ error: 'draft_id + action required' }, 400);

  const { data: draft } = await admin.from('corpus_drafts').select('*').eq('id', draft_id).single();
  if (!draft) return json({ error: 'draft not found' }, 404);
  const known = parseEntity((await admin.from('silk_config').select('value').eq('key', 'entity_master').maybeSingle()).data?.value ?? '');

  if (action === 'list') return json({ ok: true, collaborators: namedOnPage(draft.markdown_body ?? '', known) });

  if (action === 'suggest') {
    const p = String(name ?? '').toLowerCase();
    const cands = [...known.values()].filter((k) => k.name.toLowerCase().includes(p)).slice(0, 8)
      .map((k) => ({ name: k.name, section: classify(k), verified: !!(k.role || k.track) }));
    return json({ ok: true, candidates: cands });
  }

  const k = name ? known.get(String(name).toLowerCase()) : undefined;

  if (action === 'resolve') {
    if (!name) return json({ error: 'name required' }, 400);
    if (k && (k.role || k.track)) return json({ ok: true, status: 'verified', name: k.name, role: k.role ?? null, track: k.track ?? null, tier: k.tier ?? null, section: classify(k) });
    return json({ ok: true, status: 'needs_track', name, note: 'Not found in §7 or §6. Provide the track title; the ISRC must exist in the catalog before this name can be added.' });
  }

  const sec = sectionSlice(draft.markdown_body ?? '');
  if (!sec) return json({ error: `page has no "${SECTION_HEADER}" section` }, 422);

  if (action === 'add') {
    if (!name) return json({ error: 'name required' }, 400);
    // Must be verifiable: known in §7/§6, OR a provided track whose ISRC is on record.
    let verified = k && (k.role || k.track) ? { name: k!.name, role: k!.role, track: k!.track, section: classify(k!) } : null;
    if (!verified && track) {
      // check the catalog for the provided track (releases/tracks or §6 already parsed into `known` by feat.)
      const hit = [...known.values()].find((x) => x.track && x.track.toLowerCase() === String(track).toLowerCase());
      const { data: rel } = await admin.from('releases').select('title').ilike('title', `%${track}%`).limit(1);
      if (hit || (rel && rel.length)) verified = { name, role: undefined, track: String(track), section: 'Notable features' };
    }
    if (!verified) return json({ ok: false, refused: true, reason: `Cannot verify ${name}. Not in §7/§6, and no matching track on record. Not added.` }, 200);
    const instr = `ADD collaborator "${verified.name}" to the "${verified.section}" group. Verified detail — role: ${verified.role ?? '(feature)'}; track: ${verified.track ?? '(recurring)'}. Do not add a location or tier claim.`;
    const revised = await anthropicJSON(SYS, `${instr}\n\nCURRENT SECTION:\n${sec.section}`);
    if (!revised.startsWith(SECTION_HEADER)) return json({ error: 'revise failed' }, 502);
    return await applyAndReturn(draft, sec, revised, `added ${verified.name}`);
  }

  if (action === 'remove') {
    if (!name) return json({ error: 'name required' }, 400);
    const instr = `REMOVE collaborator "${name}" entirely from the section and repair the surrounding prose (commas, conjunctions) so it reads clean.`;
    const revised = await anthropicJSON(SYS, `${instr}\n\nCURRENT SECTION:\n${sec.section}`);
    if (!revised.startsWith(SECTION_HEADER)) return json({ error: 'revise failed' }, 502);
    return await applyAndReturn(draft, sec, revised, `removed ${name}`);
  }

  return json({ error: `unknown action ${action}` }, 400);
});

async function applyAndReturn(draft: any, sec: { before: string; section: string; after: string }, revisedSection: string, summary: string) {
  const newBody = sec.before + revisedSection.trimEnd() + '\n' + (sec.after.startsWith('\n') ? sec.after : '\n' + sec.after);
  const { data: v } = await admin.from('corpus_draft_versions').select('version').eq('draft_id', draft.id).order('version', { ascending: false }).limit(1);
  await admin.from('corpus_draft_versions').insert({ draft_id: draft.id, version: (v?.[0]?.version ?? 0) + 1, markdown_body: draft.markdown_body });
  await admin.from('corpus_drafts').update({ markdown_body: newBody, status: draft.status === 'published' ? 'edited' : draft.status, updated_at: new Date().toISOString() }).eq('id', draft.id);
  return json({ ok: true, summary, old_section: sec.section.trim(), new_section: revisedSection.trim() });
}
