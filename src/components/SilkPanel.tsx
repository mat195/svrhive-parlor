import { useEffect, useRef, useState } from 'react';
import { useSilk, silkPlaceholder } from '../SilkContext';

export default function SilkPanel({ variant: _variant }: { variant: 'dock' | 'sheet' }) {
  const { room, focusNode, prefill, consumePrefill, setTyping, messages, chatBusy, chatBooting, sendMessage, newChat, chats, activeChatId, loadChat } = useSilk();
  const [input, setInput] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, chatBusy]);
  useEffect(() => { if (prefill) { setInput(consumePrefill()); inputRef.current?.focus(); } }, [prefill, consumePrefill]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || chatBusy) return;
    setInput(''); setTyping(false);
    await sendMessage(text);
  }

  const header = (
    <div className="silkchat-bar">
      <button className="link small" onClick={() => newChat()}>+ New chat</button>
      {chats.length > 1 && (
        <div className="silkchat-history">
          <button className="link small" onClick={() => setShowHistory((s) => !s)}>history ▾</button>
          {showHistory && (
            <ul className="silkchat-menu">
              {chats.slice(0, 15).map((c) => (
                <li key={c.id}>
                  <button className={c.id === activeChatId ? 'active' : ''} onClick={() => { loadChat(c.id); setShowHistory(false); }}>
                    {c.title || 'Silk chat'} <span className="muted small">{String(c.created_at).slice(0, 10)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );

  const body = (
    <div className="messages" aria-live="polite">
      {chatBooting ? <div className="silk-hint">…</div>
        : messages.length === 0 && <div className="silk-hint">I'm here across every room. This is one continuous conversation — it follows you everywhere and survives a browser restart. Ask me anything.</div>}
      {messages.map((m, i) => (
        <div key={i} className={`msg ${m.role}`}>
          <div className="bubble">{m.content || (chatBusy && i === messages.length - 1 ? '…' : '')}</div>
          {m.role === 'assistant' && m.refs && m.refs.length > 0 && (
            <div className="sources">sources: {m.refs.slice(0, 6).map((r) => r.label).join(' · ')}</div>
          )}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );

  const composer = (
    <form className="composer" onSubmit={submit}>
      <input ref={inputRef} value={input}
        onChange={(e) => { setInput(e.target.value); setTyping(e.target.value.length > 0); }}
        onBlur={() => setTyping(false)}
        placeholder={silkPlaceholder(room, focusNode)} aria-label="Ask Silk" />
      <button className="btn sm" type="submit" disabled={chatBusy || !input.trim()}>Send</button>
    </form>
  );

  return <>{header}{body}{composer}</>;
}
