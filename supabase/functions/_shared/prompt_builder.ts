// system_prompt_builder (Brief Seven) — the retrieval assembly EVERY Silk LLM call
// routes through. Assembles the system prompt from the five memory layers in order,
// then records exactly what was loaded to prompt_assemblies for traceability.
//
//   L1 Core Identity  — always, never truncated (silk_config: silk_identity)
//   L2 Canonical Facts— always (silk_config: entity_master)
//   L3 Skill Playbooks— only skills triggered by the task (silk_config: skill:* + skill_registry)
//   L4 Journal/Lessons— semantically retrieved (journal_retrieve: relevant + recent + permanent)
//   L5 Ledger         — advertised query fns + a compact current-state snapshot (never bulk-loaded)
import { admin } from './auth.ts';
import { loadIdentity, loadConfig } from './silk.ts';
import { retrieve } from './journal.ts';

// Surface → default task type.
const SURFACE_TASK: Record<string, string> = {
  'silk-chat': 'chat',
  'foundry-generate': 'corpus_draft',
  'conversation-distiller': 'distillation',
  'weekly-consolidator': 'digest',
  'monthly-synthesis': 'digest',
};

// Keyword nudges — a chat/task can be about anything, so widen skill selection by
// intent. These apply on ANY surface (Brief Seven fix): a specific song/album/
// release/artist/platform mention must pull the platform-parse skills even in chat.
const KEYWORD_TASKS: [RegExp, string][] = [
  [/\bcorpus|page|draft|write a page\b/i, 'corpus_draft'],
  [/\bpitch|outreach|blog|playlist curator\b/i, 'pitch'],
  [/\bsubmit|musicbrainz|wikidata|entity submission|sameAs\b/i, 'submission'],
  [/\baudit|battery|visibility run|competitor\b/i, 'audit'],
  [/\bspotify|soundcloud|bandcamp|apple music|youtube|deezer|tidal|catalog|discograph/i, 'catalog_audit'],
  [/\b(song|track|single|album|EP|release|remix|feat\.?|featuring|streams?|monthly listeners)\b/i, 'catalog_audit'],
  [/"[^"]{2,}"|"[^"]{2,}"/, 'catalog_audit'], // any quoted title (straight or curly quotes)
  [/\bschema|json-?ld|structured data\b/i, 'corpus_draft'],
];

// Pull entity names (release titles + collaborator names) from the entity master so
// that naming a specific LPT release/artist in chat also triggers the parse skills.
function entityNames(entityMaster: string): string[] {
  const names = new Set<string>();
  for (const m of entityMaster.matchAll(/"title":\s*"([^"]{2,})"/g)) names.add(m[1].toLowerCase());
  for (const m of entityMaster.matchAll(/"featured":\s*\[([^\]]*)\]/g))
    for (const n of m[1].matchAll(/"([^"]{2,})"/g)) names.add(n[1].toLowerCase());
  // collaborator names from §7 bullets ("- **Name** — role")
  for (const m of entityMaster.matchAll(/-\s+\*\*([^*]{2,})\*\*\s+—/g)) names.add(m[1].toLowerCase().trim());
  return [...names].filter((n) => n.length >= 3);
}

// L5 query functions Silk can call (advertised; ledger stays server-side).
const LEDGER_FUNCTIONS = [
  'ledger_query_battery', 'ledger_query_mentions', 'ledger_query_metrics',
  'ledger_query_drafts', 'ledger_query_web_fetches',
];

// Task-classified max_tokens (err upward — truncation is worse than length).
// short dialog 1500 · standard 3000 · reasoning 8000 · long-form generation 16000.
const REASONING_RE = /\b(plan|planning|diff|hypothesi|autops|why did|analy[sz]e|root cause|think through|strateg|reason|walk me through|compare|trade-?off)\b/i;
const LONGFORM_TASKS = new Set(['corpus_draft', 'submission', 'audit', 'battery_report']);
function maxTokensFor(taskTypes: Set<string>, message: string): number {
  if ([...taskTypes].some((t) => LONGFORM_TASKS.has(t))) return 16000; // long-form generation
  if (REASONING_RE.test(message)) return 8000;                          // reasoning mode
  if (taskTypes.has('catalog_audit')) return 8000;                      // audit synthesis
  if (['distillation', 'digest', 'pitch'].some((t) => taskTypes.has(t))) return 3000; // standard
  const wordy = message.trim().split(/\s+/).length > 25;               // substantive chat → err upward
  return wordy ? 3000 : 1500;
}

interface Registry { name: string; triggers: string[]; always_load: boolean; depends_on: string[] }

export interface BuildInput {
  surface: string;
  message: string;          // task context used for classification + Layer 4 retrieval
  callId?: string;
  taskTypeHint?: string;
  ledgerSnapshot?: string;  // compact current-state (L5), never the bulk ledger
}
export interface BuildOutput {
  system: string; stable: string; dynamic: string; identityHash: string; assemblyId: string | null;
  taskType: string; skillsLoaded: string[]; entriesRetrieved: string[]; maxTokens: number;
}

async function loadRegistry(): Promise<Registry[]> {
  try { return JSON.parse((await loadConfig('skill_registry')).value || '[]'); } catch { return []; }
}

// Select skills: always_load ∪ triggered-by-task, then transitive depends_on.
function selectSkills(reg: Registry[], taskTypes: string[]): string[] {
  const byName = new Map(reg.map((r) => [r.name, r]));
  const chosen = new Set<string>();
  for (const r of reg) if (r.always_load || r.triggers.some((t) => taskTypes.includes(t))) chosen.add(r.name);
  let grew = true;
  while (grew) {
    grew = false;
    for (const name of [...chosen]) for (const dep of byName.get(name)?.depends_on ?? []) if (byName.has(dep) && !chosen.has(dep)) { chosen.add(dep); grew = true; }
  }
  return [...chosen];
}

export async function buildSystemPrompt(input: BuildInput): Promise<BuildOutput> {
  const { surface, message, callId, taskTypeHint, ledgerSnapshot } = input;

  // L1 / L2
  const { identity, hash: identityHash } = await loadIdentity();
  const entityMaster = (await loadConfig('entity_master')).value;

  // Task classification. Base task from hint/surface, THEN widen by intent on ANY
  // surface (Brief Seven fix): naming a specific song/album/release/artist/platform
  // pulls the platform-parse skills even in a plain chat.
  const taskType = taskTypeHint ?? SURFACE_TASK[surface] ?? 'chat';
  const taskTypes = new Set<string>([taskType]);
  for (const [re, t] of KEYWORD_TASKS) if (re.test(message)) taskTypes.add(t);
  const lower = message.toLowerCase();
  if (entityNames(entityMaster).some((n) => lower.includes(n))) taskTypes.add('catalog_audit');

  // L3
  const registry = await loadRegistry();
  const skillNames = selectSkills(registry, [...taskTypes]);
  const skillBodies: string[] = [];
  for (const name of skillNames) {
    const body = (await loadConfig(`skill:${name}`)).value;
    if (body) skillBodies.push(`### skill: ${name}\n${body}`);
  }
  // L4
  const mem = await retrieve(message, 5, 4);
  const memEntries = [
    ...mem.permanent.map((e) => ({ id: e.id, tag: 'permanent', line: e.entry })),
    ...mem.relevant.map((e) => ({ id: e.id, tag: 'relevant', line: e.entry })),
    ...mem.recent.map((e) => ({ id: e.id, tag: 'recent', line: e.entry })),
  ];
  // de-dupe by id, cap
  const seen = new Set<string>(); const memShown: typeof memEntries = [];
  for (const e of memEntries) { if (seen.has(e.id)) continue; seen.add(e.id); memShown.push(e); if (memShown.length >= 12) break; }

  // STABLE layers (L1 identity + L2 facts + L3 skills) — identical across turns of a
  // task, so they're the prompt-cache prefix. DYNAMIC layers (L4 memory + L5 ledger)
  // change per message and follow the cached prefix.
  const stable = [
    identity,
    `\n\n--- LAYER 2 · CANONICAL FACTS (Lucius P. Thundercat entity master) ---\n${entityMaster}`,
    skillBodies.length ? `\n\n--- LAYER 3 · ACTIVE SKILLS (task: ${[...taskTypes].join(', ')}) ---\n${skillBodies.join('\n\n')}` : '',
  ].filter(Boolean).join('');
  const dynamic = [
    memShown.length ? `\n\n--- LAYER 4 · RELEVANT MEMORY (retrieved from your journal — not the whole history) ---\n${memShown.map((e) => `[${e.tag}] ${e.line}`).join('\n')}` : '',
    `\n\n--- LAYER 5 · LEDGER ACCESS (queried, not loaded) ---\nRaw observations live in the ledger. You can request: ${LEDGER_FUNCTIONS.join(', ')}. Do not assume ledger facts you have not been shown.` +
      (ledgerSnapshot ? `\nCurrent snapshot:\n${ledgerSnapshot}` : ''),
  ].filter(Boolean).join('');
  const system = stable + dynamic;

  // Record the assembly (traceability: what Silk was thinking with).
  let assemblyId: string | null = null;
  try {
    const { data } = await admin.from('prompt_assemblies').insert({
      silk_call_id: callId ?? null, surface, task_type: [...taskTypes].join(','),
      layer_1_hash: identityHash,
      layer_2_sections: ['full'],
      layer_3_skills: skillNames,
      layer_4_entries: memShown.map((e) => ({ id: e.id, tag: e.tag })),
      layer_5_functions: LEDGER_FUNCTIONS,
    }).select('id').single();
    assemblyId = data?.id ?? null;
  } catch { /* audit is best-effort; never blocks a response */ }

  return { system, stable, dynamic, identityHash, assemblyId, taskType, skillsLoaded: skillNames, entriesRetrieved: memShown.map((e) => e.id), maxTokens: maxTokensFor(taskTypes, message) };
}
