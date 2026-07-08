import { useEffect, useState } from 'react';
import Queue from './Queue';
import Foundry from './Foundry';
import Listings from './Listings';
import GrantOpportunities from './GrantOpportunities';

type Tab = 'drafts' | 'actions' | 'listings' | 'grants';
const TABS: Tab[] = ['drafts', 'actions', 'listings', 'grants'];
const LABEL: Record<Tab, string> = { drafts: 'Drafts', actions: 'Actions', listings: 'Listings', grants: 'Grants' };

// Workshop = Drafts (Corpus Foundry) + Actions (action_queue) + Listings (wizards) + Grants (opportunity finder).
export default function Workshop() {
  const [tab, setTab] = useState<Tab>('drafts');

  // Deep-link from the command palette (localStorage handoff).
  useEffect(() => {
    const t = localStorage.getItem('workshop_tab');
    if (t && (TABS as string[]).includes(t)) { setTab(t as Tab); localStorage.removeItem('workshop_tab'); }
  }, []);

  return (
    <div className="stack">
      <div className="subtabs">
        {TABS.map((t) => (
          <button key={t} className={tab === t ? 'chip active' : 'chip'} onClick={() => setTab(t)}>{LABEL[t]}</button>
        ))}
      </div>
      {tab === 'drafts' ? <Foundry /> : tab === 'actions' ? <Queue /> : tab === 'listings' ? <Listings /> : <GrantOpportunities />}
    </div>
  );
}
