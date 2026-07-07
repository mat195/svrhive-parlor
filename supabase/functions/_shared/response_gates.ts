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
