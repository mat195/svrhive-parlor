// CI guard: web-fetch is read-only. Fail if its source assigns any non-GET HTTP
// method (comments mentioning the verbs are fine — we match actual `method:` use).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const f = resolve(__dirname, '..', 'supabase', 'functions', 'web-fetch', 'index.ts');
if (!existsSync(f)) { console.error('✗ web-fetch function source not found'); process.exit(1); }

const src = readFileSync(f, 'utf8');
const re = /method\s*:\s*['"`](POST|PUT|DELETE|PATCH|HEAD)['"`]/gi;
const hits = [...src.matchAll(re)].map((m) => m[0]);

if (hits.length) {
  console.error(`✗ web-fetch must be GET-only — found non-GET method(s): ${hits.join(', ')}`);
  process.exit(1);
}
if (!/method\s*:\s*['"`]GET['"`]/.test(src)) {
  console.error('✗ web-fetch: expected an explicit GET method');
  process.exit(1);
}
console.log('✓ check-web-fetch-verbs: GET-only.');
