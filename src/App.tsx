import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, OWNER_EMAIL } from './lib/supabase';
import SignIn from './components/SignIn';
import MorningBrief from './views/MorningBrief';
import Ledger from './views/Ledger';
import Queue from './views/Queue';
import Silk from './views/Silk';
import Watchtower from './views/Watchtower';

type View = 'brief' | 'ledger' | 'queue' | 'silk' | 'watchtower';
const TABS: { id: View; label: string }[] = [
  { id: 'brief', label: 'Brief' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'queue', label: 'Queue' },
  { id: 'silk', label: 'Silk' },
  { id: 'watchtower', label: 'Watch' },
];

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<View>('brief');

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!ready) return <div className="center muted">…</div>;

  // Guard: only the owner email is allowed a session (defense-in-depth; RLS also enforces).
  if (!session || session.user.email !== OWNER_EMAIL) {
    return <SignIn wrongUser={!!session && session.user.email !== OWNER_EMAIL} />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">The Parlor</span>
        <button className="link" onClick={() => supabase.auth.signOut()}>sign out</button>
      </header>

      <main className="viewport">
        {view === 'brief' && <MorningBrief />}
        {view === 'ledger' && <Ledger />}
        {view === 'queue' && <Queue />}
        {view === 'silk' && <Silk />}
        {view === 'watchtower' && <Watchtower />}
      </main>

      <nav className="tabbar" aria-label="Views">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={view === t.id ? 'tab active' : 'tab'}
            aria-current={view === t.id ? 'page' : undefined}
            onClick={() => setView(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
