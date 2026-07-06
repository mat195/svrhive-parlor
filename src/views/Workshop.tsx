import { useState } from 'react';
import Queue from './Queue';
import Foundry from './Foundry';

// Workshop = Actions (the existing action_queue) + Drafts (Corpus Foundry).
export default function Workshop() {
  const [tab, setTab] = useState<'actions' | 'drafts'>('drafts');
  return (
    <div className="stack">
      <div className="subtabs">
        <button className={tab === 'drafts' ? 'chip active' : 'chip'} onClick={() => setTab('drafts')}>Drafts</button>
        <button className={tab === 'actions' ? 'chip active' : 'chip'} onClick={() => setTab('actions')}>Actions</button>
      </div>
      {tab === 'drafts' ? <Foundry /> : <Queue />}
    </div>
  );
}
