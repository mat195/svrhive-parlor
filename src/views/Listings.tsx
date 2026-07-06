import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

interface Step { key: string; label: string; value: string; note?: string; optional?: boolean; url?: string }
interface Wizard {
  id: string; key: string; title: string; platform: string; entity: string;
  order_index: number; target_url: string | null; intro: string | null; steps: Step[];
}

function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button className="btn sm ghost copybtn" disabled={!text} onClick={async () => {
      try { await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1200); } catch { /* noop */ }
    }}>{ok ? 'Copied ✓' : 'Copy'}</button>
  );
}

function WizardRunner({ wizard, done, onToggle }: { wizard: Wizard; done: Set<string>; onToggle: (stepKey: string, next: boolean) => void }) {
  const total = wizard.steps.length;
  const complete = wizard.steps.filter((s) => done.has(s.key)).length;
  return (
    <div className="stack">
      {wizard.intro && <p className="muted">{wizard.intro}</p>}
      {wizard.target_url && (
        <a className="btn sm" href={wizard.target_url} target="_blank" rel="noopener">Open submission page ↗</a>
      )}
      <div className="wiz-progress"><span style={{ width: `${(complete / total) * 100}%` }} /></div>
      <div className="muted small">{complete}/{total} done</div>

      {wizard.steps.map((s, i) => {
        const isDone = done.has(s.key);
        return (
          <div className={isDone ? 'card wizstep done' : 'card wizstep'} key={s.key}>
            <div className="row-head">
              <span className="wiz-num">{i + 1}. {s.label}{s.optional && <span className="muted small"> · optional</span>}</span>
              <label className="check"><input type="checkbox" checked={isDone} onChange={(ev) => onToggle(s.key, ev.target.checked)} /> done</label>
            </div>
            {s.value ? (
              <div className="wiz-value">
                <pre>{s.value}</pre>
                <CopyBtn text={s.value} />
              </div>
            ) : <p className="muted small">{s.note || 'skip — not confirmed yet'}</p>}
            {s.value && s.note && <p className="muted small">{s.note}</p>}
          </div>
        );
      })}
    </div>
  );
}

export default function Listings() {
  const [wizards, setWizards] = useState<Wizard[] | null>(null);
  const [progress, setProgress] = useState<Record<string, Set<string>>>({});
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: w } = await supabase.from('listing_wizards').select('*').order('order_index');
    setWizards((w as Wizard[]) ?? []);
    const { data: p } = await supabase.from('listing_progress').select('wizard_key, done_steps');
    const map: Record<string, Set<string>> = {};
    (p ?? []).forEach((r: any) => (map[r.wizard_key] = new Set(r.done_steps ?? [])));
    setProgress(map);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function toggle(wizardKey: string, stepKey: string, next: boolean) {
    const cur = new Set(progress[wizardKey] ?? []);
    if (next) cur.add(stepKey); else cur.delete(stepKey);
    setProgress((p) => ({ ...p, [wizardKey]: cur }));
    await supabase.from('listing_progress').upsert(
      { wizard_key: wizardKey, done_steps: [...cur], updated_at: new Date().toISOString() },
      { onConflict: 'wizard_key' },
    );
  }

  if (!wizards) return <p className="muted">Loading…</p>;

  const totalSteps = wizards.reduce((n, w) => n + w.steps.length, 0);
  const doneSteps = wizards.reduce((n, w) => n + w.steps.filter((s) => (progress[w.key] ?? new Set()).has(s.key)).length, 0);
  const ready = wizards.length >= 5;

  if (open) {
    const w = wizards.find((x) => x.key === open)!;
    return (
      <div className="stack">
        <button className="btn sm ghost" onClick={() => setOpen(null)}>← All wizards</button>
        <h2 style={{ marginTop: 0 }}>{w.title}</h2>
        <WizardRunner wizard={w} done={progress[w.key] ?? new Set()} onToggle={(sk, nx) => toggle(w.key, sk, nx)} />
      </div>
    );
  }

  return (
    <div className="stack">
      <section className={ready ? 'card sprint ok' : 'card sprint'}>
        <strong>{ready ? '✅ Listing Sprint — ready' : '⏳ Wizards not generated yet'}</strong>
        <div className="muted small">
          {ready
            ? `All ${wizards.length} wizards live. Do them in order. Overall: ${doneSteps}/${totalSteps} fields done.`
            : 'Do not start pasting until all five wizards are live.'}
        </div>
        <div className="wiz-progress"><span style={{ width: `${totalSteps ? (doneSteps / totalSteps) * 100 : 0}%` }} /></div>
      </section>

      {wizards.map((w, i) => {
        const d = progress[w.key] ?? new Set();
        const complete = w.steps.filter((s) => d.has(s.key)).length;
        const prev = wizards[i - 1];
        const prevDone = !prev || (progress[prev.key] ?? new Set()).size >= prev.steps.filter((s) => !s.optional).length;
        return (
          <button className="card wizcard" key={w.key} onClick={() => setOpen(w.key)}>
            <div className="row-head">
              <span className="wiz-num">{w.order_index}. {w.title}</span>
              <span className={complete === w.steps.length ? 'chip ok' : 'chip'}>{complete}/{w.steps.length}</span>
            </div>
            <div className="muted small">{w.platform} · {w.entity}{!prevDone && <span> · do after #{w.order_index - 1}</span>}</div>
          </button>
        );
      })}
    </div>
  );
}
