// Brain snapshot of the entity model, with confidence states. Mirrors the
// svrhive entity master (regenerate when it changes). Phase 1 is a committed
// snapshot; a later phase can DB-back + realtime this.
export type Confidence = 'verified' | 'unverified' | 'quarantined' | 'superseded';

export interface Node { key: string; label: string; confidence: Confidence; note?: string; url?: string; missing?: boolean }

export const identity: Node[] = [
  { key: 'identity-name', label: 'Lucius P. Thundercat', confidence: 'verified' },
  { key: 'identity-umbrella', label: 'hip-hop rapper & vocalist', confidence: 'verified' },
  { key: 'identity-descriptor', label: 'spanning soulful sample-based hip-hop, boom bap, trap, lofi', confidence: 'verified' },
  { key: 'identity-bio', label: 'Bio (100w) — approved & live', confidence: 'verified' },
  { key: 'identity-disambig', label: 'Not affiliated with Thundercat (Stephen Bruner)', confidence: 'verified' },
  { key: 'identity-location', label: 'Montréal, Québec, Canada', confidence: 'verified' },
  { key: 'identity-active-since', label: 'Active since — ?', confidence: 'unverified', note: 'TODO(Mat)' },
  { key: 'identity-realname', label: 'Real-name policy — ?', confidence: 'unverified' },
  { key: 'identity-producer', label: 'previously mislabeled "producer"', confidence: 'superseded', note: 'Corrected to rapper/vocalist' },
];

export const genres = {
  core: ['soulful sample-based hip-hop', 'boom bap', 'trap', 'lofi hip-hop / jazz-hop', 'melodic hip-hop / R&B-rap'],
  quarantined: ['cinematic / score', 'ambient interludes'],
};

export const catalog: Node[] = [
  { key: 'rel-must-be-love', label: 'Must Be Love (feat. Magi Merlin & Frei)', confidence: 'verified' },
  { key: 'rel-grind-and-stack', label: 'Grind and Stack', confidence: 'verified' },
  { key: 'rel-love-potion', label: 'Love Potion (feat. Sunnie) · 2022', confidence: 'verified' },
  { key: 'rel-tempo', label: 'Tempo (feat. Sunnie) · 2023', confidence: 'verified' },
  { key: 'rel-next-man-remix', label: 'Next Man [Remix] (feat. Muffin) · 2023', confidence: 'verified' },
  { key: 'rel-they-are-not-your-friends-remix', label: 'They Are Not Your Friends [Remix] · 2023', confidence: 'verified' },
  { key: 'rel-wish-you-the-best', label: 'Wish You the Best', confidence: 'verified' },
  { key: 'rel-neck-me-down-oclock', label: "Neck Me Down O'clock", confidence: 'verified' },
  { key: 'rel-love-you-leave-you', label: 'Love You/Leave You (feat. LPT)', confidence: 'unverified' },
  { key: 'rel-forbidden-fruit', label: 'Forbidden Fruit (feat. Curtis Williams & LPT)', confidence: 'verified' },
];

export const collaborators: Node[] = [
  { key: 'collab-nick-nigh', label: 'Nick Nigh', confidence: 'verified', note: 'producer + vocalist' },
  { key: 'collab-sunnie', label: 'Sunnie', confidence: 'verified', note: 'vocalist' },
  { key: 'collab-magi-merlin', label: 'Magi Merlin', confidence: 'verified', note: 'vocalist' },
  { key: 'collab-curtis-williams', label: 'Curtis Williams', confidence: 'verified', note: 'vocalist' },
  { key: 'collab-frei', label: 'Frei', confidence: 'unverified', note: 'vocalist?' },
  { key: 'collab-muffin', label: 'Muffin', confidence: 'unverified', note: 'vocalist?' },
  { key: 'collab-briley-bell', label: 'Briley Bell', confidence: 'unverified' },
  { key: 'collab-lawrence-bossong', label: 'Lawrence A. Bossong', confidence: 'unverified' },
];

export const platforms: Node[] = [
  { key: 'platform-spotify', label: 'Spotify', confidence: 'verified', url: 'https://open.spotify.com/artist/2lhuyLLQPcfoXSwcNaXuF1' },
  { key: 'platform-apple', label: 'Apple Music', confidence: 'verified', url: 'https://music.apple.com/us/artist/lucius-p-thundercat/958381434' },
  { key: 'platform-deezer', label: 'Deezer', confidence: 'verified', url: 'https://www.deezer.com/en/artist/7367252' },
  { key: 'platform-tidal', label: 'TIDAL', confidence: 'verified', url: 'https://tidal.com/browse/artist/6441893' },
  { key: 'platform-youtube', label: 'YouTube', confidence: 'unverified', note: 'official channel status TODO', url: 'https://www.youtube.com/channel/UCFLo4zgjKpAk1IZ4rCDdw5g' },
  { key: 'platform-bandcamp', label: 'Bandcamp', confidence: 'verified', url: 'https://luciuspthundercat.bandcamp.com' },
  { key: 'platform-website', label: 'Official website', confidence: 'verified', url: 'https://luciuspthundercat.com' },
  { key: 'platform-facebook', label: 'Facebook', confidence: 'verified', url: 'https://www.facebook.com/luciuspthundercat' },
  { key: 'platform-soundcloud', label: 'SoundCloud', confidence: 'verified', url: 'https://soundcloud.com/lpthrilla' },
  { key: 'platform-x', label: 'X (Twitter)', confidence: 'verified', url: 'https://x.com/thrillalpt' },
  { key: 'platform-instagram', label: 'Instagram', confidence: 'unverified', missing: true },
  { key: 'platform-tiktok', label: 'TikTok', confidence: 'unverified', missing: true },
  { key: 'platform-genius', label: 'Genius', confidence: 'unverified', missing: true },
];

export const referenceRappers: string[] = []; // probe instrument lives in prompts.json, not identity

export const RINGS = [
  { key: 'identity', label: 'Identity' },
  { key: 'catalog', label: 'Catalog' },
  { key: 'collaborators', label: 'Collaborators' },
  { key: 'platforms', label: 'Platforms' },
  { key: 'discovery', label: 'Discovery signal' },
  { key: 'timeline', label: 'Timeline' },
];
