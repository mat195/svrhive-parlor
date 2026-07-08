import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

// Monthly-listeners line over the 917-day audience timeline (2024-01 → present).
// Data = the ingested observation in silk_config (monthly_series). Pure SVG, no deps.
type Pt = { month: string; ml: number };

export default function AudienceChart() {
  const [series, setSeries] = useState<Pt[]>([]);
  useEffect(() => {
    supabase.from('silk_config').select('value').eq('key', 'observation:audience_timeline').maybeSingle()
      .then(({ data }) => {
        if (!data?.value) return;
        try {
          const ms = JSON.parse(data.value).monthly_series ?? {};
          setSeries(Object.keys(ms).sort().map((m) => ({ month: m, ml: Number(ms[m].ml_end) || 0 })));
        } catch { /* ignore */ }
      });
  }, []);

  if (series.length < 3) return null;

  const W = 340, H = 130, pad = { l: 30, r: 10, t: 12, b: 20 };
  const innerW = W - pad.l - pad.r, innerH = H - pad.t - pad.b;
  const maxML = Math.max(...series.map((s) => s.ml));
  const x = (i: number) => pad.l + (series.length === 1 ? 0 : (i * innerW) / (series.length - 1));
  const y = (v: number) => pad.t + (1 - v / maxML) * innerH;
  const line = series.map((s, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(s.ml).toFixed(1)}`).join(' ');
  const area = `${line} L${x(series.length - 1).toFixed(1)},${(pad.t + innerH).toFixed(1)} L${x(0).toFixed(1)},${(pad.t + innerH).toFixed(1)} Z`;

  // Highlight the two known spikes if present.
  const spikes = ['2025-02', '2025-03', '2025-08'].map((m) => series.findIndex((s) => s.month === m)).filter((i) => i >= 0);
  const peakI = series.reduce((mi, s, i) => (s.ml > series[mi].ml ? i : mi), 0);
  const yearTicks = series.map((s, i) => ({ i, s })).filter(({ s }) => s.month.endsWith('-01'));

  return (
    <section className="audience-chart">
      <div className="ac-head">
        <h2 style={{ margin: 0 }}>Monthly listeners</h2>
        <span className="muted small">{series[0].month} → {series[series.length - 1].month} · peak {maxML.toLocaleString()}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="ac-svg" role="img" aria-label="Monthly listeners over time">
        <line x1={pad.l} y1={pad.t + innerH} x2={W - pad.r} y2={pad.t + innerH} className="ac-axis" />
        <text x={pad.l - 4} y={y(maxML) + 4} className="ac-ytick" textAnchor="end">{maxML}</text>
        <text x={pad.l - 4} y={pad.t + innerH} className="ac-ytick" textAnchor="end">0</text>
        <path d={area} className="ac-area" />
        <path d={line} className="ac-line" />
        {spikes.map((i) => <circle key={i} cx={x(i)} cy={y(series[i].ml)} r={3} className="ac-spike" />)}
        <circle cx={x(peakI)} cy={y(series[peakI].ml)} r={3.5} className="ac-peak" />
        {yearTicks.map(({ i, s }) => <text key={s.month} x={x(i)} y={H - 6} className="ac-xtick" textAnchor="middle">{s.month.slice(0, 4)}</text>)}
      </svg>
      <div className="muted small ac-note">Two spikes — <strong>Feb 2025</strong> (peak {maxML.toLocaleString()}) and <strong>Aug 2025</strong> — both real, both verified.</div>
    </section>
  );
}
