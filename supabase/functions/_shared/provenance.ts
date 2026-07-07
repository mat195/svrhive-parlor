// Publish-time provenance gate. Mirrors svrhive-site/scripts/provenance-lint.mjs.
// Flags producer/production language ONLY when it is attributed to Lucius P. Thundercat
// himself — not when it accurately describes a collaborator who happens to sit near his
// name (e.g. "Nick Nigh (producer and vocalist)" is a true, verified role and must survive).
export const CANON = 'Lucius P. Thundercat';

const PRODUCE = /produc\w*/i; // whole word: produce/producer/producers/producing/production
const NEGATED = /\b(not|never|no|isn'?t|aren'?t)\b|n'?t\b/i;
// Between LPT's name and the producer word, any of these means the role belongs to a
// DIFFERENT, named entity: another proper (multi-word) name, a feature/credit marker, or
// an opening parenthesis introducing a role tag — "Name (producer …)".
const OTHER_BEFORE = /[A-Z][a-z]+\s+[A-Z][a-z]+|feat\.?|\bfeaturing\b|\(/;

export function provenanceIssues(markdown: string): string[] {
  const issues = new Set<string>();
  const md = markdown ?? '';
  let i = 0;
  while ((i = md.indexOf(CANON, i)) !== -1) {
    // The clause that begins at LPT's name (up to the next sentence/clause boundary).
    const clause = md.slice(i + CANON.length).split(/[.!?\n;:]/)[0];
    const p = clause.search(PRODUCE);
    if (p !== -1) {
      const before = clause.slice(0, p);
      const afterWord = clause.slice(p).replace(PRODUCE, '');
      // Attributed to a collaborator if another entity precedes the word, or a proper name
      // immediately follows it ("producer Frei").
      const belongsToOther = OTHER_BEFORE.test(before) || /^\s+[A-Z][a-z]/.test(afterWord);
      if (!NEGATED.test(before) && !belongsToOther) {
        issues.add(`producer language attributed to "${CANON}" — identity drift`);
      }
    }
    i += CANON.length;
  }
  return [...issues];
}
