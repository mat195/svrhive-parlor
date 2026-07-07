// Response gates (Brief Nine P1-4 / P2-6) — action rules compiled to checks that run
// on the drafted response before it reaches Mat. Text rules don't bind behaviour; gates do.
const FETCH_TOOLS = new Set([
  'web_fetch', 'spotify_lookup', 'spotify_track_details', 'spotify_artist_catalog',
  'read_config_file', 'journal_retrieve', 'get_action_queue_item', 'get_ledger_record',
  'ledger_query_battery', 'ledger_query_mentions', 'ledger_query_drafts', 'ledger_query_web_fetches',
]);

// SOURCING gate: did Silk ask Mat for data he could have fetched himself?
export function asksForFetchable(text: string): boolean {
  return /\b(can you|could you|please|would you)\b[^.?!]*\b(paste|provide|send|share|give me|hand me|drop)\b/i.test(text)
    || /\b(paste|send|provide)\s+(me\s+)?(the|that|a)\b/i.test(text);
}
export function usedFetchTool(toolTrace: { name: string }[]): boolean {
  return toolTrace.some((t) => FETCH_TOOLS.has(t.name));
}

// VERIFY-BEFORE-DONE gate: a claim of state change must be backed by a verification
// tool result THIS turn — else soften to "attempted, unverified".
const STATE_CLAIM = /\b(i(?:'ve| have)?\s+(created|updated|applied|filed|saved|inserted|added|deleted|published|committed|persisted|wrote|written|marked|approved|rejected|queued)|it'?s\s+(done|created|updated|saved|filed|applied|queued)|successfully\s+\w+ed)\b/i;
export function verifyBeforeDone(text: string, toolTrace: { name: string; result?: unknown }[]): { text: string; softened: boolean } {
  if (!STATE_CLAIM.test(text)) return { text, softened: false };
  const backed = toolTrace.some((t) =>
    /queue_for_approval|foundry|extraction|propagate/.test(t.name) ||
    (t.result && /verified|"ok":true|write_proof|item_id/.test(JSON.stringify(t.result))));
  if (backed) return { text, softened: false };
  return { text: `_(attempted — not yet verified; no confirmation tool ran this turn)_\n\n${text}`, softened: true };
}

// FORMAT gate (P1-4): replies over ~20 lines, or with §-references in the prose, get
// auto-reformatted to decision-first shape before sending. Cheap model, big scannability win.
export function needsReformat(text: string): boolean {
  const lines = text.split('\n').filter((l) => l.trim()).length;
  return lines > 20 || /§\s*\d/.test(text);
}
export async function reformat(text: string, anthropicKey: string, formatRules: string): Promise<string> {
  const system =
    'You reformat Silk V1\'s reply for Mat reading on his phone. Keep Silk\'s voice and EVERY piece of substance; cut only padding.\n' +
    formatRules.slice(0, 2500) +
    '\nHard rules: decision-first (the takeaway/next action up top); scannable in 15 seconds; short bullets / small tables over paragraphs; NO "§" section references or internal file paths in the visible text (say it in Mat\'s words); sign-offs stay. Output ONLY the reformatted reply — no preamble.';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1500, system, messages: [{ role: 'user', content: text }] }),
    });
    const data = await res.json();
    const out = (data?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
    return out || text;
  } catch { return text; }
}

// SELF-VERIFICATION pass (P2-6): a cheap second model audits the drafted reply against
// the tool evidence gathered THIS turn. It lists the factual system-state claims about
// Lucius P. Thundercat / Silk Velvet Records (metrics, mentions, catalog/label facts,
// counts, dates) and marks each supported or not by the tool results. Unsupported factual
// claims get hedged; everything else is returned verbatim. This catches confident
// fabrication that the regex verifyBeforeDone gate (state-change verbs only) can't.
//
// Gated by shouldSelfVerify() so it only fires when the reply actually asserts checkable
// facts — no cost on chit-chat.
const FACT_SHAPE = /\b(\d[\d,.]*\s*(streams?|listeners?|plays?|mentions?|followers?|releases?|tracks?|songs?|%|percent)|mentioned by|appears? in|cited|ranked|charted|labe(l|led)|copyright|released (on|in)|feat\.?|featuring)\b/i;
export function shouldSelfVerify(text: string, toolTrace: { name: string }[]): boolean {
  if (text.trim().split(/\s+/).length < 12) return false;        // too short to carry a checkable claim
  if (/\bi (don'?t|do not) (have|know)|not in (my|the) (context|records)|can'?t confirm\b/i.test(text)) return false; // already hedged
  return FACT_SHAPE.test(text) || toolTrace.length > 0;          // asserts a metric/fact, or leaned on tools
}

export async function selfVerify(
  text: string,
  toolTrace: { name: string; result?: unknown }[],
  anthropicKey: string,
): Promise<{ text: string; softened: boolean; unsupported: string[] }> {
  // Compact evidence digest — tool names + trimmed results — is all the auditor gets.
  const evidence = toolTrace.length
    ? toolTrace.map((t, i) => `[${i + 1}] ${t.name}: ${JSON.stringify(t.result ?? {}).slice(0, 900)}`).join('\n')
    : '(no tools were called this turn — the reply must rest on the layered context only)';
  const system =
    'You audit a drafted reply from Silk (an AI visibility scout for the artist Lucius P. Thundercat / label Silk Velvet Records) BEFORE it reaches the owner.\n' +
    'You are given the reply and the TOOL EVIDENCE gathered this turn. Find every FACTUAL claim about the artist/label/metrics/catalog (numbers, mentions, followers, streams, labels, copyrights, release dates, "appears in X", counts, rankings).\n' +
    'For each, decide: is it directly supported by the tool evidence (or trivially general knowledge that asserts nothing specific about the artist/label)? Claims with no supporting evidence are UNSUPPORTED.\n' +
    'Then output ONLY JSON: {"unsupported":["<short quote of each unsupported factual claim>"],"revised":"<the reply with each unsupported factual claim hedged in Silk\'s voice (e.g. \'~\', \'unverified\', \'I don\'t have a source for\') — keep EVERYTHING else identical, keep formatting, do not add preamble>"}\n' +
    'If every factual claim is supported (or there are none), return {"unsupported":[],"revised":"<the reply unchanged>"}. Never invent new facts; only hedge or pass through.';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000, system, messages: [{ role: 'user', content: `REPLY:\n${text}\n\nTOOL EVIDENCE:\n${evidence}` }] }),
    });
    const data = await res.json();
    const raw = (data?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { text, softened: false, unsupported: [] };
    const parsed = JSON.parse(m[0]);
    const unsupported: string[] = Array.isArray(parsed.unsupported) ? parsed.unsupported.filter((s: unknown) => typeof s === 'string') : [];
    const revised = typeof parsed.revised === 'string' ? parsed.revised.trim() : '';
    if (unsupported.length && revised) return { text: revised, softened: true, unsupported };
    return { text, softened: false, unsupported: [] };
  } catch { return { text, softened: false, unsupported: [] }; }
}
