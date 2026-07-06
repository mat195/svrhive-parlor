import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { streamSilkChat, type LedgerRef } from '../lib/api';
import { useSilk, silkPlaceholder } from '../SilkContext';

interface Msg { role: 'user' | 'assistant'; content: string; refs?: LedgerRef[] }

// Known Brain nodes Silk can "point" at when he names them.
const NODE_MAP: [RegExp, string][] = [
  [/\bfrei\b/i, 'collab-frei'], [/\bmuffin\b/i, 'collab-muffin'], [/\bnick nigh\b/i, 'collab-nick-nigh'],
  [/\bsunnie\b/i, 'collab-sunnie'], [/\bmagi merlin\b/i, 'collab-magi-merlin'], [/\bcurtis williams\b/i, 'collab-curtis-williams'],
  [/\bspotify\b/i, 'platform-spotify'], [/\byoutube\b/i, 'platform-youtube'], [/\bbandcamp\b/i, 'platform-bandcamp'],
  [/\bsilk velvet\b/i, 'svr'], [/\blucius p\.? thundercat\b/i, 'lpt'],
];

export default function SilkPanel({ variant }: { variant: 'dock' | 'sheet' }) {
  const { room, focusNode, prefill, consumePrefill, pointAt, setTyping, setChatBusy } = useSilk();
  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [err, setErr] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, streaming]);

  // "Ask Silk about this" → pipe text into the input.
  useEffect(() => {
    if (prefill) { setInput(consumePrefill()); inputRef.current?.focus(); }
  }, [prefill]);

  async function ensureChat(): Promise<string> {
    if (chatId) return chatId;
    const { data } = await supabase.from('parlor_chats').insert({ title: 'Silk chat' }).select('id').single();
    const id = data!.id as string; setChatId(id); return id;
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || streaming) return;
    setErr(''); setInput(''); setTyping(false);
    const id = await ensureChat();
    await supabase.from('parlor_messages').insert({ chat_id: id, role: 'user', content: text });
    setMessages((m) => [...m, { role: 'user', content: text }, { role: 'assistant', content: '', refs: [] }]);
    setStreaming(true); setChatBusy(true);
    try {
      const { text: full } = await streamSilkChat({
        chatId: id, message: text,
        onRefs: (refs) => setMessages((m) => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], refs }; return c; }),
        onDelta: (t) => setMessages((m) => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], content: c[c.length - 1].content + t }; return c; }),
      });
      // Silk points: pulse the first Brain node he named.
      const hit = NODE_MAP.find(([re]) => re.test(full));
      if (hit) pointAt(hit[1]);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setStreaming(false); setChatBusy(false); }
  }

  const composer = (
    <form className="composer" onSubmit={send}>
      <input ref={inputRef} value={input}
        onChange={(e) => { setInput(e.target.value); setTyping(e.target.value.length > 0); }}
        onBlur={() => setTyping(false)}
        placeholder={silkPlaceholder(room, focusNode)} aria-label="Ask Silk" />
      <button className="btn sm" type="submit" disabled={streaming || !input.trim()}>Send</button>
    </form>
  );

  const body = (
    <div className="messages" aria-live="polite">
      {messages.length === 0 && <div className="silk-hint">I'm here across every room. Ask me anything about the ledger, the Brain, or a draft.</div>}
      {messages.map((m, i) => (
        <div key={i} className={`msg ${m.role}`}>
          <div className="bubble">{m.content || (streaming && i === messages.length - 1 ? '…' : '')}</div>
          {m.role === 'assistant' && m.refs && m.refs.length > 0 && (
            <div className="sources">sources: {m.refs.slice(0, 6).map((r) => r.label).join(' · ')}</div>
          )}
        </div>
      ))}
      {err && <div className="err small">{err}</div>}
      <div ref={endRef} />
    </div>
  );

  if (variant === 'sheet') return <>{body}{composer}</>;
  return <>{body}{composer}</>;
}
