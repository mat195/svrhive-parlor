// Foundation Rule 4: no service key or LLM key anywhere in the frontend bundle.
// Scans src + the built dist for key-shaped strings AND for the anon key being
// mistaken for a service key. Fails CI on any hit.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOTS = ['src', 'dist'];
const SKIP = new Set(['node_modules', '.git']);
const EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.html', '.css', '.map']);

const PATTERNS = [
  { name: 'Anthropic key', re: /sk-ant-[A-Za-z0-9_-]{10,}/ },
  { name: 'OpenAI key', re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { name: 'Perplexity key', re: /pplx-[A-Za-z0-9]{20,}/ },
  { name: 'Supabase service_role literal', re: /service_role/ },
  { name: 'sb_secret key', re: /sb_secret_[A-Za-z0-9]{10,}/ },
  // A JWT whose role claim is service_role (base64 of "role":"service_role").
  { name: 'service_role JWT', re: /InNlcnZpY2Vfcm9sZSI/ },
];

const hits = [];
function walk(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (EXT.has(extname(p))) {
      const text = readFileSync(p, 'utf8');
      for (const { name, re } of PATTERNS) if (re.test(text)) hits.push(`${p}: ${name}`);
    }
  }
}
for (const r of ROOTS) walk(r);

if (hits.length) {
  console.error('✗ SECRET LEAK in frontend/bundle:');
  for (const h of hits) console.error('  ' + h);
  process.exit(1);
}
console.log('✓ check-secrets: no service/LLM key in src or dist.');
