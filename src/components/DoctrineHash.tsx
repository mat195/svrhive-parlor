import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useSilk } from '../SilkContext';

// Shows the runtime rules hash so Mat can verify at a glance that the deployed
// runtime is bound to the expected rules — and taps through to the Rules view.
export default function DoctrineHash() {
  const { setRoom } = useSilk();
  const [hash, setHash] = useState<string | null>(null);
  useEffect(() => {
    supabase.from('silk_config').select('hash').eq('key', 'silk_identity').maybeSingle()
      .then(({ data }) => setHash(data?.hash ?? null));
  }, []);
  if (!hash) return null;
  return (
    <button className="doctrine-hash" title="Silk's live rules — tap to view" onClick={() => setRoom('rules')}>
      Rules: <code>{hash}</code>
    </button>
  );
}
