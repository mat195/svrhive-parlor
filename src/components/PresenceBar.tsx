import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useSilk } from '../SilkContext';

interface Status {
  id: string; state: string; label: string | null; sublabel: string | null;
  progress: { done?: number; total?: number } | null;
  started_at: string; updated_at: string; done_at: string | null; source: string | null;
}

const STALE_MS = 10 * 60 * 1000;
const CANCELLABLE = new Set(['foundry-generate', 'catalog-audit', 'catalog-audit-supplemental']);

export default function PresenceBar() {
  const { typing, chatBusy } = useSilk();
  const [server, setServer] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    const { data } = await supabase.from('silk_status').select('*').order('updated_at', { ascending: false }).limit(1);
    setServer((data?.[0] as Status) ?? null);
  }, []);

  useEffect(() => {
    load();
    const ch = supabase.channel('silk-status').on('postgres_changes', { event: '*', schema: 'public', table: 'silk_status' }, () => load()).subscribe();
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => { supabase.removeChannel(ch); clearInterval(t); };
  }, [load]);

  // Heartbeat: a task that never marked done_at goes stale → revert to idle + journal.
  useEffect(() => {
    if (server && !server.done_at && Date.now() - Date.parse(server.updated_at) > STALE_MS) {
      supabase.from('silk_status').update({ done_at: new Date().toISOString(), state: 'idle' }).eq('id', server.id).then(() => {
        supabase.from('silk_journal').insert({ entry: `Stale task cleared: "${server.label}" (${server.source}) ran >10 min without completing. Reverted Presence Bar to idle.`, tags: ['presence', 'stale', 'debug'] });
        load();
      });
    }
  }, [server, now, load]);

  // Resolve the visible state (server active > chat thinking > typing > idle; brief reporting flash).
  const serverActive = server && !server.done_at && Date.now() - Date.parse(server.updated_at) <= STALE_MS ? server : null;
  const reportingFlash = server && server.done_at && server.state === 'reporting' && Date.now() - Date.parse(server.done_at) < 1800 ? server : null;

  let state: string, label: string, sub: string | null = null, working: Status | null = null;
  if (serverActive && (serverActive.state === 'working' || serverActive.state === 'thinking' || serverActive.state === 'distilling')) {
    state = serverActive.state; label = serverActive.label ?? serverActive.state; sub = serverActive.sublabel; working = serverActive;
  } else if (reportingFlash) {
    state = 'reporting'; label = 'just posted an update';
  } else if (chatBusy) {
    state = 'thinking'; label = 'thinking…';
  } else if (typing) {
    state = 'listening'; label = 'reading you…';
  } else {
    state = 'idle'; label = 'here — ask me anything';
  }

  const progress = working?.progress;
  const elapsed = working ? Math.max(0, Math.round((now - Date.parse(working.started_at)) / 1000)) : 0;

  async function cancel() {
    if (!working) return;
    await supabase.from('silk_status').update({ done_at: new Date().toISOString(), state: 'idle' }).eq('id', working.id);
    await supabase.from('silk_journal').insert({ entry: `Mat cancelled: "${working.label}" (${working.source}).`, tags: ['presence', 'cancel'] });
    setOpen(false); load();
  }

  return (
    <div className={`presence presence-${state}`}>
      <button className="presence-bar" onClick={() => working && setOpen((o) => !o)} aria-label={`Silk status: ${label}`}>
        <span className={`presence-dot dot-${state}`} />
        <span className="presence-state">{state}</span>
        <span className="presence-label">{label}{sub ? ` · ${sub}` : ''}{progress?.total ? ` · ${progress.done ?? 0}/${progress.total}` : ''}</span>
      </button>
      {open && working && (
        <div className="presence-drawer">
          <div><strong>{working.label}</strong>{working.sublabel ? ` — ${working.sublabel}` : ''}</div>
          <div className="muted small">elapsed {elapsed}s{progress?.total ? ` · ${progress.done ?? 0}/${progress.total}` : ''} · source: {working.source}</div>
          <div className="presence-drawer-acts">
            <button className="link small" onClick={() => setOpen(false)}>view journal ↗</button>
            {CANCELLABLE.has(working.source ?? '') && <button className="link small" onClick={cancel}>cancel</button>}
          </div>
        </div>
      )}
    </div>
  );
}
