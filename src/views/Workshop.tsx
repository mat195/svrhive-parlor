import { useState } from 'react';
import Queue from './Queue';
import Foundry from './Foundry';
import Listings from './Listings';

// Workshop = Drafts (Corpus Foundry) + Actions (action_queue) + Listings (wizards).
export default function Workshop() {
  const [tab, setTab] = useState<'drafts' | 'actions' | 'listings'>('drafts');
  return (
    <div className="stack">
      <div className="subtabs">
        <button className={tab === 'drafts' ? 'chip active' : 'chip'} onClick={() => setTab('drafts')}>Drafts</button>
        <button className={tab === 'actions' ? 'chip active' : 'chip'} onClick={() => setTab('actions')}>Actions</button>
        <button className={tab === 'listings' ? 'chip active' : 'chip'} onClick={() => setTab('listings')}>Listings</button>
      </div>
      {tab === 'drafts' ? <Foundry /> : tab === 'actions' ? <Queue /> : <Listings />}
    </div>
  );
}
