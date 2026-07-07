import { useEffect, useState } from 'react';
import Queue from './Queue';
import Foundry from './Foundry';
import Listings from './Listings';

type Tab = 'drafts' | 'actions' | 'listings';

// Workshop = Drafts (Corpus Foundry) + Actions (action_queue) + Listings (wizards).
export default function Workshop() {
  const [tab, setTab] = useState<Tab>('drafts');

  // Deep-link from the command palette (localStorage handoff).
  useEffect(() => {
    const t = localStorage.getItem('workshop_tab');
    if (t === 'drafts' || t === 'actions' || t === 'listings') { setTab(t); localStorage.removeItem('workshop_tab'); }
  }, []);

  return (
    <div className="stack">
      <div className="subtabs">
        {(['drafts', 'actions', 'listings'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'chip active' : 'chip'} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
        ))}
      </div>
      {tab === 'drafts' ? <Foundry /> : tab === 'actions' ? <Queue /> : <Listings />}
    </div>
  );
}
