// Publish-time provenance gate. Mirrors svrhive-site/scripts/provenance-lint.mjs
// (the CI linter) but runs BEFORE foundry-publish commits, so a draft with identity
// drift can never reach the live repo in the first place — CI is too late (already
// committed). Checked against the draft markdown (frontmatter + body).
export const CANON = 'Lucius P. Thundercat';

const PRODUCE = /produc(e|es|er|ers|ing|tion)/i;
const ALLOW = /(not|never|n't)\s+produc/i; // e.g. "does not produce" — don't false-flag

// Returns [] when clean, else a list of human-readable identity-drift issues.
export function provenanceIssues(markdown: string): string[] {
  const issues: string[] = [];
  const md = markdown ?? '';
  // Producer/production language in the vicinity of the canonical name = identity drift
  // (Lucius P. Thundercat is a rapper/vocalist, not a producer). Same window as CI.
  let i = 0;
  while ((i = md.indexOf(CANON, i)) !== -1) {
    const win = md.slice(Math.max(0, i - 60), i + 200);
    if (PRODUCE.test(win) && !ALLOW.test(win)) {
      issues.push(`producer/production language near "${CANON}" — identity drift`);
      break;
    }
    i += CANON.length;
  }
  // The blanket red-flag phrase must never appear on our own site.
  if (/hip[- ]hop producer/i.test(md)) issues.push('contains the phrase "hip-hop producer"');
  return issues;
}
