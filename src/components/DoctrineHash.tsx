import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

// Shows the runtime identity hash so Mat can verify at a glance that the deployed
// runtime is bound to the expected SILK_IDENTITY.md doctrine.
export default function DoctrineHash() {
  const [hash, setHash] = useState<string | null>(null);
  useEffect(() => {
    supabase.from('silk_config').select('hash, updated_at').eq('key', 'silk_identity').maybeSingle()
      .then(({ data }) => setHash(data?.hash ?? null));
  }, []);
  if (!hash) return null;
  return (
    <div className="doctrine-hash" title="Runtime SILK_IDENTITY.md version bound to every Silk call">
      doctrine <code>{hash}</code>
    </div>
  );
}
