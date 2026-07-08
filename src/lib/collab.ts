// Derive a collaborator directory from what's actually in the DB: there is no
// collaborators table — features live in releases.label_credit (e.g. "feat. Project Pat",
// "feat. Che Noir, Mooch", "feat. Frei & Nick Nigh"). This is the single source both the
// People directory and the Brain "Collaborators" ring read from, so they never disagree.

export interface ReleaseLite {
  id: string;
  title: string;
  catalog_number: string | null;
  release_date: string | null;
  tier: number | null;
  streams: number | null;
  label_credit: string | null;
  spotify_album_id: string | null;
}

export interface CollabRelease { id: string; title: string; catalog: string | null; year: string | null; tier: number | null; streams: number; albumId: string | null }
export interface Collaborator {
  name: string;
  role: string;
  local: 'yes' | 'no' | 'unknown';
  trackCount: number;
  combinedStreams: number;
  tierDist: Record<number, number>;
  mostRecent: string | null;
  notable: boolean;               // "name-recognition" — national/high-reach feature
  verifiedBy: string;
  releases: CollabRelease[];
}

// Locality, grounded in the entity master's stated facts (not guessed):
//  - "Montréal scene" collaborators named in §7 → yes
//  - out-of-town features with known home scenes → no
//  - everyone else → unknown (honest default; no fabricated locality)
const MONTREAL = new Set(['magi merlin', 'nick nigh', 'king mizery', 'frei', 'muffin']);
const NON_LOCAL = new Set(['project pat', 'og maco', 'che noir', 'skyzoo', 'ransom', 'add-2', 'curtis williams']);
// National name-recognition features (used by the "name-recognition only" filter).
const NAME_RECOGNITION = new Set(['project pat', 'og maco', 'che noir', 'skyzoo', 'ransom', 'add-2']);
// Credits that are beat/production provenance, not public vocal features.
const PRODUCERS = new Set(['frei', 'muffin']);

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Pull collaborator names out of a label_credit string. */
export function parseCredit(labelCredit: string | null): string[] {
  if (!labelCredit) return [];
  let s = labelCredit.replace(/\(?\s*(feat\.?|featuring|ft\.?|with)\s*/gi, ' ').replace(/[()]/g, ' ');
  return s
    .split(/,|&|\/| x |\band\b/gi)
    .map((x) => x.replace(/\s+/g, ' ').trim())
    .filter((x) => x.length > 1 && !/lucius p\.? thundercat|^lpt$/i.test(x) && !/silk velvet|records|remix|sped up|slowed/i.test(x));
}

const localityOf = (n: string): 'yes' | 'no' | 'unknown' => (MONTREAL.has(n) ? 'yes' : NON_LOCAL.has(n) ? 'no' : 'unknown');

/** Build the full collaborator directory from the releases list. */
export function buildDirectory(releases: ReleaseLite[]): Collaborator[] {
  const map = new Map<string, Collaborator & { _name: string }>();
  for (const r of releases) {
    for (const raw of parseCredit(r.label_credit)) {
      const key = norm(raw);
      let c = map.get(key);
      if (!c) {
        c = {
          _name: raw, name: raw, role: PRODUCERS.has(key) ? 'Producer' : 'Featured artist',
          local: localityOf(key), trackCount: 0, combinedStreams: 0, tierDist: {}, mostRecent: null,
          notable: NAME_RECOGNITION.has(key), verifiedBy: 'Spotify release credits', releases: [],
        };
        map.set(key, c);
      }
      const yr = r.release_date ? r.release_date.slice(0, 4) : null;
      c.releases.push({ id: r.id, title: r.title, catalog: r.catalog_number, year: yr, tier: r.tier, streams: Number(r.streams ?? 0), albumId: r.spotify_album_id });
      c.trackCount++;
      c.combinedStreams += Number(r.streams ?? 0);
      if (r.tier != null) c.tierDist[r.tier] = (c.tierDist[r.tier] ?? 0) + 1;
      if (r.release_date && (!c.mostRecent || r.release_date > c.mostRecent)) c.mostRecent = r.release_date;
    }
  }
  const out = [...map.values()];
  // "Notable" also if they appear on a Tier-1 release or clear the 10k-stream bar — data-driven,
  // not just the curated national set.
  for (const c of out) {
    if (!c.notable && (c.tierDist[1] > 0 || c.combinedStreams >= 10_000)) c.notable = true;
    c.releases.sort((a, b) => b.streams - a.streams);
  }
  return out;
}

export type SortKey = 'tracks' | 'streams' | 'recent' | 'alpha';
export function sortDirectory(list: Collaborator[], key: SortKey): Collaborator[] {
  const c = [...list];
  if (key === 'tracks') c.sort((a, b) => b.trackCount - a.trackCount || b.combinedStreams - a.combinedStreams);
  else if (key === 'streams') c.sort((a, b) => b.combinedStreams - a.combinedStreams);
  else if (key === 'recent') c.sort((a, b) => (b.mostRecent ?? '').localeCompare(a.mostRecent ?? ''));
  else c.sort((a, b) => a.name.localeCompare(b.name));
  return c;
}
