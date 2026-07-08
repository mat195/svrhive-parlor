import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, OWNER_EMAIL } from './lib/supabase';
import { SilkProvider, useSilk, type Room } from './SilkContext';
import SignIn from './components/SignIn';
import SilkPanel from './components/SilkPanel';
import QuestionsStrip from './components/QuestionsStrip';
import ExtractionsCard from './components/ExtractionsCard';
import PresenceBar from './components/PresenceBar';
import DoctrineHash from './components/DoctrineHash';
import { ToastProvider } from './components/Toast';
import CommandPalette from './components/CommandPalette';
import { Spider, Wordmark } from './components/Marks';
import Brief from './views/Brief';
import Ledger from './views/Ledger';
import Brain from './views/Brain';
import People from './views/People';
import Workshop from './views/Workshop';
import Watchtower from './views/Watchtower';
import Archive from './views/Archive';
import Rules from './views/Rules';

const ROOMS: { id: Room; label: string }[] = [
  { id: 'brief', label: 'Brief' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'brain', label: 'Brain' },
  { id: 'people', label: 'People' },
  { id: 'workshop', label: 'Workshop' },
  { id: 'watchtower', label: 'Watch' },
  { id: 'archive', label: 'Archive' },
  { id: 'rules', label: 'Rules' },
];

function parseHash(): { room?: Room; node?: string } {
  const seg = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (!seg.length) return {};
  const room = seg[0] as Room;
  let node: string | undefined;
  if (room === 'brain' && seg[1] === 'lpt' && seg[2]) {
    const ring = seg[2], name = seg[3];
    if (ring === 'collaborators' && name) node = 'collab-' + name;
    else if (ring === 'platforms' && name) node = 'platform-' + name;
    else if (ring === 'catalog' && name) node = 'rel-' + name;
    else node = 'lpt';
  } else if (room === 'brain' && seg[1]) node = seg[1];
  return { room, node };
}

function RoomView({ room }: { room: Room }) {
  switch (room) {
    case 'brief': return <Brief />;
    case 'ledger': return <Ledger />;
    case 'brain': return <Brain />;
    case 'people': return <People />;
    case 'workshop': return <Workshop />;
    case 'watchtower': return <Watchtower />;
    case 'archive': return <Archive />;
    case 'rules': return <Rules />;
  }
}

function HQ() {
  const { room, setRoom, setFocusNode } = useSilk();
  const [running, setRunning] = useState(false);
  const [sheet, setSheet] = useState<'peek' | 'h66' | 'h100'>('peek');

  // Deep-link on mount.
  useEffect(() => {
    const { room: r, node } = parseHash();
    if (r && ROOMS.some((x) => x.id === r)) setRoom(r);
    if (node) setFocusNode(node);
    // presence: is a battery running (a run in the last ~4 min)?
    supabase.from('visibility_runs').select('run_at').order('run_at', { ascending: false }).limit(1)
      .then(({ data }) => { const t = data?.[0]?.run_at ? Date.parse(data[0].run_at) : 0; setRunning(Date.now() - t < 4 * 60 * 1000); });
  }, []);

  // Reflect brain navigation in the URL (shallow).
  useEffect(() => { if (room === 'brain') history.replaceState(null, '', '#/brain'); }, [room]);

  const presence = (
    <span className="presence">{running ? <><span className="pulse" /> running</> : 'here'}</span>
  );

  return (
    <div className="hq">
      <aside className="rail">
        <div className="brand"><Spider size={18} className="spider" /><Wordmark /></div>
        <nav>
          {ROOMS.map((r) => (
            <button key={r.id} className={room === r.id ? 'roombtn active' : 'roombtn'} aria-current={room === r.id ? 'page' : undefined} onClick={() => setRoom(r.id)}>{r.label}</button>
          ))}
        </nav>
        <div style={{ marginTop: 'auto', padding: '0.6rem' }}>
          <button className="link" style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '0.8rem' }} onClick={() => supabase.auth.signOut()}>sign out</button>
        </div>
      </aside>

      <main className="canvas">
        <div className="canvas-inner">
          <RoomView room={room} />
        </div>
      </main>

      <aside className="silkdock">
        <PresenceBar />
        <QuestionsStrip />
        <ExtractionsCard />
        <header><Spider size={16} className="spider" /><strong style={{ fontFamily: 'var(--serif)' }}>Silk</strong>{presence}<DoctrineHash /></header>
        <SilkPanel variant="dock" />
      </aside>

      {/* Mobile */}
      <div className={`silksheet ${sheet}`}>
        <div className="grip" onClick={() => setSheet(sheet === 'peek' ? 'h66' : sheet === 'h66' ? 'h100' : 'peek')}>
          <Spider size={14} className="spider" /> Silk {running && <span className="pulse" style={{ display: 'inline-block' }} />} <span className="muted">— tap to {sheet === 'peek' ? 'open' : 'close'}</span>
        </div>
        {sheet !== 'peek' && <><PresenceBar /><QuestionsStrip /><ExtractionsCard /><SilkPanel variant="sheet" /></>}
      </div>
      <nav className="mobtabs" aria-label="Rooms">
        {ROOMS.map((r) => (
          <button key={r.id} className={room === r.id ? 'active' : ''} onClick={() => setRoom(r.id)}>{r.label}</button>
        ))}
      </nav>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!ready) return <div className="center muted">…</div>;
  if (!session || session.user.email !== OWNER_EMAIL) return <SignIn wrongUser={!!session && session.user.email !== OWNER_EMAIL} />;

  return <SilkProvider><ToastProvider><CommandPalette /><HQ /></ToastProvider></SilkProvider>;
}
