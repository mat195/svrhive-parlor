import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { streamSilkChat, type LedgerRef } from '../lib/api';

interface Msg { role: 'user' | 'assistant'; content: string; refs?: LedgerRef[] }

export default function Silk() {
  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [err, setErr] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, streaming]);

  async function ensureChat(): Promise<string> {
    if (chatId) return chatId;
    const { data } = await supabase.from('parlor_chats').insert({ title: 'Silk chat' }).select('id').single();
    const id = data!.id as string;
    setChatId(id);
    return id;
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || streaming) return;
    setErr('');
    setInput('');
    const id = await ensureChat();
    await supabase.from('parlor_messages').insert({ chat_id: id, role: 'user', content: text });

    setMessages((m) => [...m, { role: 'user', content: text }, { role: 'assistant', content: '', refs: [] }]);
    setStreaming(true);
    try {
      await streamSilkChat({
        chatId: id,
        message: text,
        onRefs: (refs) => setMessages((m) => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], refs }; return c; }),
        onDelta: (t) => setMessages((m) => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], content: c[c.length - 1].content + t }; return c; }),
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setStreaming(false);
    }
  }

  return (
    <div className="chat">
      <div className="messages">
        {messages.length === 0 && (
          <div className="muted hint">
            Ask Silk. Try: “What changed this week?” · “Why did lofi drop?” · “Draft a corpus page spec for ‘Montreal instrumental producers’”.
            <br />Prefix <code>/deep</code> for the stronger model.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="bubble">{m.content || (streaming && i === messages.length - 1 ? '…' : '')}</div>
            {m.role === 'assistant' && m.refs && m.refs.length > 0 && (
              <div className="sources">sources: {m.refs.slice(0, 8).map((r) => r.label).join(' · ')}</div>
            )}
          </div>
        ))}
        {err && <div className="err">{err}</div>}
        <div ref={endRef} />
      </div>
      <form className="composer" onSubmit={send}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask Silk…" disabled={streaming} />
        <button className="btn sm" type="submit" disabled={streaming || !input.trim()}>Send</button>
      </form>
    </div>
  );
}
