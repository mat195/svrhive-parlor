import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';

interface Visit {
  id: string; ts: string; path: string; referrer_host: string | null;
  is_ai_referrer: boolean; country: string | null;
}

function startOf(kind: 'day' | 'week' | 'month'): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (kind === 'week') d.setDate(d.getDate() - 6);
  if (kind === 'month') d.setDate(d.getDate() - 29);
  return d.toISOString();
}

async function count(sinceIso: string): Promise<number> {
  const { count } = await supabase
    .from('site_visits').select('id', { count: 'exact', head: true }).gte('ts', sinceIso);
  return count ?? 0;
}

export default function Watchtower() {
  const [counts, setCounts] = useState({ day: 0, week: 0, month: 0 });
  const [feed, setFeed] = useState<Visit[]>([]);
  const [byRef, setByRef] = useState<{ host: string; n: number; ai: boolean }[]>([]);
  const [trophy, setTrophy] = useState<Visit | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const [d, w, m] = await Promise.all([count(startOf('day')), count(startOf('week')), count(startOf('month'))]);
    setCounts({ day: d, week: w, month: m });

    const { data: recent } = await supabase
      .from('site_visits').select('id, ts, path, referrer_host, is_ai_referrer, country')
      .order('ts', { ascending: false }).limit(20);
    setFeed(recent ?? []);

    // referrer grouping over the last 30 days
    const { data: month } = await supabase
      .from('site_visits').select('referrer_host, is_ai_referrer').gte('ts', startOf('month')).limit(2000);
    const map = new Map<string, { n: number; ai: boolean }>();
    (month ?? []).forEach((v) => {
      const host = v.referrer_host || 'direct / none';
      const cur = map.get(host) ?? { n: 0, ai: !!v.is_ai_referrer };
      cur.n++; cur.ai = cur.ai || !!v.is_ai_referrer;
      map.set(host, cur);
    });
    const rows = [...map.entries()].map(([host, x]) => ({ host, n: x.n, ai: x.ai }));
    rows.sort((a, b) => (Number(b.ai) - Number(a.ai)) || (b.n - a.n)); // AI pinned to top
    setByRef(rows);

    const { data: firstAi } = await supabase
      .from('site_visits').select('id, ts, path, referrer_host, is_ai_referrer, country')
      .eq('is_ai_referrer', true).order('ts', { ascending: true }).limit(1);
    setTrophy(firstAi?.[0] ?? null);
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 20000); // live-ish
    return () => clearInterval(t);
  }, [load]);

  if (!loaded) return <p className="muted">Loading…</p>;

  return (
    <div className="stack">
      <section className="counts3">
        {(['day', 'week', 'month'] as const).map((k) => (
          <div className="count-card" key={k}>
            <div className="count-n">{counts[k]}</div>
            <div className="muted small">{k === 'day' ? 'today' : k === 'week' ? '7 days' : '30 days'}</div>
          </div>
        ))}
      </section>

      <section className={trophy ? 'card trophy won' : 'card trophy'}>
        {trophy ? (
          <>
            <div className="trophy-badge">🏆 First AI visitor</div>
            <div className="trophy-meta">
              <strong>{trophy.referrer_host}</strong> → {trophy.path}<br />
              <span className="muted small">{new Date(trophy.ts).toLocaleString()}</span>
            </div>
          </>
        ) : (
          <div className="muted">🏆 First AI visitor — <em>not yet.</em> The trophy fires the moment an answer engine sends someone. This is the whole point.</div>
        )}
      </section>

      <section>
        <h2>By referrer <span className="muted small">(AI pinned)</span></h2>
        {byRef.length === 0 ? <p className="muted">No visits yet.</p> : (
          <ul className="linklist">
            {byRef.slice(0, 12).map((r) => (
              <li key={r.host}>
                <span>{r.ai && <span className="pill hit" style={{ marginRight: 6 }}>AI</span>}{r.host}</span>
                <span className="muted">{r.n}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Live feed <span className="muted small">· last 20</span></h2>
        {feed.length === 0 ? <p className="muted">Quiet so far.</p> : (
          <ul className="rows">
            {feed.map((v) => (
              <li key={v.id} className="row feed-row">
                <span className="feed-path">{v.path}</span>
                <span className="muted small">
                  {v.is_ai_referrer && <span className="pill hit" style={{ marginRight: 6 }}>AI</span>}
                  {v.referrer_host || 'direct'}{v.country ? ` · ${v.country}` : ''} · {new Date(v.ts).toLocaleTimeString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
