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
