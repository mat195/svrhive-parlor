import { supabase, SUPABASE_URL } from './supabase';

export interface LedgerRef {
  kind: string;
  id?: string;
  label: string;
}

/** Stream a Silk reply from the silk-chat Edge Function. Parses the SSE events
 *  (refs / delta / done). Returns the final refs + full text. */
export async function streamSilkChat(opts: {
  chatId: string;
  message: string;
  deep?: boolean;
  onRefs?: (refs: LedgerRef[], model: string) => void;
  onDelta?: (text: string) => void;
}): Promise<{ text: string; refs: LedgerRef[] }> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('not signed in');

  const res = await fetch(`${SUPABASE_URL}/functions/v1/silk-chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: opts.chatId, message: opts.message, deep: opts.deep ?? false }),
  });

  if (res.status === 429) throw new Error('Rate limit — wait a minute.');
  if (!res.ok || !res.body) throw new Error(`silk-chat ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  let refs: LedgerRef[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const chunks = buf.split('\n\n');
    buf = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const evLine = chunk.match(/^event: (.*)$/m)?.[1];
      const dataLine = chunk.match(/^data: (.*)$/m)?.[1];
      if (!evLine || !dataLine) continue;
      const payload = JSON.parse(dataLine);
      if (evLine === 'refs') {
        refs = payload.ledger_refs ?? [];
        opts.onRefs?.(refs, payload.model);
      } else if (evLine === 'delta') {
        full += payload.text;
        opts.onDelta?.(payload.text);
      }
    }
  }
  return { text: full, refs };
}
