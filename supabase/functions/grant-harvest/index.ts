// grant-harvest (Opportunity Finder — Grants, Phase 1). Weekly: fetch the deadline /
// eligibility pages of five Canadian arts funders, extract each program (name, deadline,
// eligibility, funding range, apply URL), and screen it for whether Lucius P. Thundercat /
// Silk Velvet Records plausibly qualifies. Upserts grant_opportunities, journals genuine
// strong recurring fits as a standing annual check, and files ONE green queue summary.
//
// Informational only — this NEVER applies to anything. Grant applications need real human
// writing and judgment. Deliberately out of scope (no reliable/API-friendly source, would
// fail silently): monitoring social media / X / Reddit / Instagram / feature marketplaces.
import { admin, requireOwner, json, CORS } from '../_shared/auth.ts';
import { fileQueueItem } from '../_shared/queue.ts';
import { verifyWrite } from '../_shared/silk.ts';
import { startStatus, stepStatus, endStatus } from '../_shared/status.ts';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const CRON_KEY = Deno.env.get('CRON_KEY') ?? '';
const MODEL = 'claude-sonnet-4-6';

// Confirmed-current URLs (verified via search 2026-07; these funders reshuffle pages
// periodically, so the extractor reads whole-page text rather than fixed selectors —
// structure changes degrade gracefully instead of breaking).
const SOURCES: { funder: string; urls: string[] }[] = [
  { funder: 'FACTOR', urls: [
    'https://www.factor.ca/artists/deadlines/',
    'https://www.factor.ca/programs/artist-programs/',
  ] },
  { funder: 'Musicaction', urls: [
    'https://musicaction.ca/programmes/',
    'https://musicaction.ca/programmes/production-dun-album/',
    'https://musicaction.ca/programmes/developpement-de-la-carriere-dartistes-de-competences-et-daffaires/',
  ] },
  { funder: 'SOCAN Foundation', urls: [
    'https://www.socanfoundation.ca/deadlines/',
    'https://www.socanfoundation.ca/grants/',
  ] },
  { funder: 'CALQ', urls: [
    'https://www.calq.gouv.qc.ca/aide-financiere/programmes-daides-financiere/artistes/',
    'https://www.calq.gouv.qc.ca/aides/creation/',
  ] },
  { funder: 'Canada Council for the Arts', urls: [
    'https://canadacouncil.ca/funding/grants/deadlines',
    'https://canadacouncil.ca/funding/grants/explore-and-create',
  ] },
];

// The profile the extractor screens each program against. Facts only; no invented status.
const PROFILE = `Lucius P. Thundercat — an independent hip-hop / rap recording artist. His label is
Silk Velvet Records, an independent Canadian record label based in Montréal, Québec, Canada. He is a
solo, self-releasing independent artist (72 releases), not signed to a major and not an
organization/ensemble/presenter. Screen against: an individual, Quebec-domiciled, Canadian, genre = hip-hop/rap.
Treat as UNKNOWN (so, "maybe" if a program hinges on it): SOCAN membership, prior grant history,
citizenship/PR paperwork, exact years of professional practice.`;

const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

// Cheap, dependency-free HTML → readable text. Drops script/style/nav noise, keeps block
// structure as newlines so the model sees program blocks, then caps length.
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/li|\/h[1-6]|\/tr|\/div)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"').replace(/&eacute;/gi, 'é').replace(/&egrave;/gi, 'è')
    .replace(/[ \t\f\v]+/g, ' ').replace(/\n\s*\n\s*/g, '\n').trim();
}

async function fetchText(url: string): Promise<{ ok: boolean; text?: string; status?: number; error?: string }> {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'SVRHive-GrantScout/1.0 (silkvelvetrecords.com)', 'Accept': 'text/html' } });
    if (!r.ok) return { ok: false, status: r.status, error: `HTTP ${r.status}` };
    const text = htmlToText(await r.text());
    return { ok: true, text, status: r.status };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

interface Extracted {
  program_name: string; deadline_iso: string | null; deadline_note: string | null;
  eligibility_summary: string | null; funding_min: number | null; funding_max: number | null;
  funding_note: string | null; application_url: string | null;
  relevance: 'fit' | 'maybe' | 'not_eligible'; relevance_note: string | null;
  recurring_annual: boolean; source_excerpt: string | null;
}

async function extractPrograms(funder: string, corpus: string): Promise<Extracted[]> {
  const system =
    `You extract music-grant programs from funder web pages and screen them for one artist. ` +
    `ARTIST/LABEL PROFILE:\n${PROFILE}\n\n` +
    `Return ONLY minified JSON: {"programs":[{` +
    `"program_name":string,` +
    `"deadline_iso":string|null (YYYY-MM-DD of the NEXT/upcoming deadline; null if rolling or not stated — NEVER guess a date),` +
    `"deadline_note":string|null (e.g. "Rolling — apply before project start", or "Single/EP stream" when disambiguating multiple),` +
    `"eligibility_summary":string|null (one sentence, English, even if the page is French),` +
    `"funding_min":number|null,"funding_max":number|null (CAD dollars, only if a number is stated),` +
    `"funding_note":string|null (e.g. "50% of eligible expenses, max $10,000"),` +
    `"application_url":string|null (the program's own page/apply URL if shown),` +
    `"relevance":"fit"|"maybe"|"not_eligible",` +
    `"relevance_note":string|null (ONE line: the single deciding factor),` +
    `"recurring_annual":boolean (true if it runs on a repeating annual cycle),` +
    `"source_excerpt":string|null (<=200 chars, VERBATIM from the page, showing where the deadline/amount came from)` +
    `}]}\n\n` +
    `RELEVANCE RUBRIC:\n` +
    `- "fit": open to individual independent artists in Canada/Quebec, genre-agnostic (or incl. hip-hop/rap), for sound recording / creation / production / artist career development — he plausibly qualifies now.\n` +
    `- "maybe": plausibly qualifies but hinges on a gate to verify (SOCAN membership; francophone-content quota; emerging/"relève"/first-time-only or a max years-of-practice rule; must-not-have-prior-funding; project-timing rules).\n` +
    `- "not_eligible": clearly excludes him (students/post-secondary enrolment only; organizations/ensembles/presenters/labels-as-orgs only; requires something he lacks).\n\n` +
    `RULES: If a program has several distinct deadlines/streams, emit one object per stream so each can be sorted by its own date. ` +
    `Extract ONLY what the page states — if a field isn't on the page, use null. Do not invent deadlines or amounts. ` +
    `Skip pure news/blog items and org-operating-grant streams that obviously can't apply to a solo artist. Empty list is valid.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 2600, system, messages: [{ role: 'user', content: `FUNDER: ${funder}\n\nPAGE TEXT:\n${corpus}` }] }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = (data?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
  const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  return Array.isArray(parsed?.programs) ? parsed.programs : [];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  // Cron (x-cron-key) OR owner JWT (so Mat can trigger a refresh by hand).
  const cronOk = CRON_KEY && req.headers.get('x-cron-key') === CRON_KEY;
  if (!cronOk) { const auth = await requireOwner(req); if (!auth.ok) return auth.res; }
  if (!ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not set' }, 500);

  const statusId = await startStatus('working', 'grant scout', 'grant-harvest', `${SOURCES.length} funders`);
  const now = new Date().toISOString();
  const fetchLog: { funder: string; ok: boolean; note: string }[] = [];
  const upserted: { funder: string; program_name: string; relevance: string; deadline: string | null; is_new: boolean }[] = [];
  const journaledFits: string[] = [];

  try {
    // Which program_ids already exist? Needed to (a) preserve first_seen and (b) journal a
    // strong recurring fit only the FIRST time we see it (no weekly repeats).
    const { data: existingRows } = await admin.from('grant_opportunities').select('program_id');
    const existing = new Set((existingRows ?? []).map((r: any) => r.program_id));

    for (const src of SOURCES) {
      await stepStatus(statusId, `reading ${src.funder}`);
      // Concatenate this funder's pages (deadlines + program detail), capped so the model
      // sees the whole thing without blowing the context.
      const parts: string[] = [];
      let anyOk = false; const failed: string[] = [];
      for (const url of src.urls) {
        const r = await fetchText(url);
        if (r.ok && r.text) { anyOk = true; parts.push(`# SOURCE: ${url}\n${r.text.slice(0, 9000)}`); }
        else failed.push(`${url} (${r.error ?? r.status})`);
      }
      if (!anyOk) { fetchLog.push({ funder: src.funder, ok: false, note: `all pages failed: ${failed.join('; ')}` }); continue; }

      let programs: Extracted[] = [];
      try { programs = await extractPrograms(src.funder, parts.join('\n\n').slice(0, 16000)); }
      catch (e) { fetchLog.push({ funder: src.funder, ok: false, note: `extract failed: ${e instanceof Error ? e.message : String(e)}` }); continue; }

      let wrote = 0;
      for (const p of programs) {
        if (!p?.program_name) continue;
        const program_id = `${slug(src.funder)}:${slug(p.program_name)}${p.deadline_note ? '-' + slug(p.deadline_note).slice(0, 20) : ''}`;
        const is_new = !existing.has(program_id);
        const deadline = /^\d{4}-\d{2}-\d{2}$/.test(p.deadline_iso ?? '') ? p.deadline_iso : null;
        const row: Record<string, unknown> = {
          program_id, funder: src.funder, program_name: p.program_name,
          deadline, deadline_note: p.deadline_note ?? null,
          eligibility_summary: p.eligibility_summary ?? null,
          funding_min: Number.isFinite(p.funding_min as number) ? p.funding_min : null,
          funding_max: Number.isFinite(p.funding_max as number) ? p.funding_max : null,
          funding_note: p.funding_note ?? null,
          application_url: p.application_url ?? src.urls[0],
          relevance: ['fit', 'maybe', 'not_eligible'].includes(p.relevance) ? p.relevance : 'maybe',
          relevance_note: p.relevance_note ?? null,
          recurring_annual: !!p.recurring_annual,
          source_url: src.urls[0], source_excerpt: (p.source_excerpt ?? '').slice(0, 400) || null,
          status: 'active', fetched_at: now, updated_at: now,
        };
        if (is_new) row.first_seen = now;
        const { error } = await admin.from('grant_opportunities').upsert(row, { onConflict: 'program_id' });
        if (error) { fetchLog.push({ funder: src.funder, ok: false, note: `upsert ${program_id}: ${error.message}` }); continue; }
        wrote++;
        upserted.push({ funder: src.funder, program_name: p.program_name, relevance: row.relevance as string, deadline, is_new });
        existing.add(program_id);

        // Standing recurring check: journal a genuine strong fit the first time it appears,
        // so annual programs surface in Silk's memory as a repeating yearly opportunity.
        if (is_new && row.relevance === 'fit' && row.recurring_annual) {
          const line = `Grant fit (recurring): ${src.funder} — ${p.program_name}${deadline ? `, next deadline ${deadline}` : ''}. ${p.relevance_note ?? ''} A strong standing fit for Lucius P. Thundercat; annual — re-check each cycle. Informational (Mat decides whether to apply).`;
          await admin.from('silk_journal').insert({ entry: line.trim(), tags: ['grant', 'opportunity-finder', 'recurring', 'fit'] });
          journaledFits.push(`${src.funder} — ${p.program_name}`);
        }
      }
      fetchLog.push({ funder: src.funder, ok: true, note: `${wrote} program(s)` });
    }

    // ── ONE green queue summary (informational; no external impact) ──────────
    const fits = upserted.filter((u) => u.relevance === 'fit');
    const maybes = upserted.filter((u) => u.relevance === 'maybe');
    const dated = upserted
      .filter((u) => u.relevance !== 'not_eligible' && u.deadline && u.deadline >= now.slice(0, 10))
      .sort((a, b) => (a.deadline as string).localeCompare(b.deadline as string));
    const next = dated[0];
    const title = `Grant scout — ${upserted.length} program(s): ${fits.length} fit, ${maybes.length} maybe` +
      (next ? ` · next deadline ${next.deadline} (${next.funder} — ${next.program_name})` : '');

    const qi = await fileQueueItem({
      kind: 'grant-opportunities', risk_tier: 'green', maxPerDay: 1,
      payload: {
        title,
        rationale:
          `Weekly scan of FACTOR, Musicaction, SOCAN Foundation, CALQ, and Canada Council. ` +
          `${fits.length} look like clear fits, ${maybes.length} are maybes (a gate to verify). ` +
          `Full list with deadlines is in Workshop → Grants. Informational only — nothing here applies to anything; ` +
          `grant applications need real writing and judgment.` +
          (journaledFits.length ? ` Journaled as standing annual checks: ${journaledFits.join('; ')}.` : '') +
          ` Out of scope by design (no reliable source, would fail silently): monitoring social media / X / Reddit / Instagram / feature-marketplace sites.`,
        upcoming: dated.slice(0, 6),
        fetch_status: fetchLog,
        source: 'grant-harvest',
      },
    });

    const proof = qi?.id ? await verifyWrite('action_queue', { id: qi.id }) : { ok: false, detail: 'no queue id' };
    await endStatus(statusId, true);
    return json({ ok: true, programs: upserted.length, fits: fits.length, maybes: maybes.length, journaled: journaledFits.length, fetch_status: fetchLog, write_proof: (proof as any).detail });
  } catch (e) {
    await endStatus(statusId, false);
    return json({ error: e instanceof Error ? e.message : String(e), fetch_status: fetchLog }, 500);
  }
});
