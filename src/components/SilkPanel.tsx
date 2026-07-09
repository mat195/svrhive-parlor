import { useEffect, useRef, useState } from 'react';
import { useSilk, silkPlaceholder } from '../SilkContext';

export default function SilkPanel({ variant: _variant }: { variant: 'dock' | 'sheet' }) {
  const { room, focusNode, prefill, consumePrefill, setTyping, messages, chatBusy, chatBooting, sendMessage, newChat, chats, archivedChats, activeChatId, loadChat, archiveChat, pinnedDraft, clearPinnedDraft } = useSilk();
  const [input, setInput] = useState('');
  const [showThreads, setShowThreads] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [listening, setListening] = useState(false);
  const [images, setImages] = useState<{ media_type: string; data: string; name: string }[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recogRef = useRef<any>(null);

  // Paperclip → file picker → base64. The bridge for login-walled data with no API
  // (e.g. Spotify for Artists screenshots): Silk reads the numbers straight off the image.
  async function onFiles(files: FileList | null) {
    if (!files) return;
    const picked = await Promise.all(Array.from(files).filter((f) => f.type.startsWith('image/')).slice(0, 4).map((f) =>
      new Promise<{ media_type: string; data: string; name: string }>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve({ media_type: f.type, data: String(r.result).split(',')[1] ?? '', name: f.name });
        r.readAsDataURL(f);
      })));
    setImages((prev) => [...prev, ...picked].slice(0, 4));
    if (fileRef.current) fileRef.current.value = '';
  }

  // Web Speech API dictation (mic → text field). Gracefully absent if unsupported.
  const SpeechRec = typeof window !== 'undefined' ? ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition) : null;
  function toggleMic() {
    if (!SpeechRec) return;
    if (listening) { recogRef.current?.stop(); return; }
    const r = new SpeechRec();
    r.lang = 'en-US'; r.interimResults = true; r.continuous = false;
    let base = input ? input + ' ' : '';
    r.onresult = (e: any) => {
      let txt = '';
      for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
      setInput(base + txt); setTyping(true);
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    recogRef.current = r; setListening(true); r.start();
  }

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, chatBusy]);
  useEffect(() => { if (prefill) { setInput(consumePrefill()); inputRef.current?.focus(); } }, [prefill, consumePrefill]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if ((!text && images.length === 0) || chatBusy) return;
    const imgs = images.map(({ media_type, data }) => ({ media_type, data }));
    setInput(''); setImages([]); setTyping(false);
    await sendMessage(text, imgs);
  }

  const ago = (iso?: string | null) => {
    if (!iso) return '';
    const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  };
  const activeThread = chats.find((c) => c.id === activeChatId) ?? archivedChats.find((c) => c.id === activeChatId);
  const openThread = (id: string) => { loadChat(id); setShowThreads(false); };

  const header = (
    <div className="silkchat-bar">
      <button className="thread-switch" onClick={() => setShowThreads((s) => !s)} title="Switch thread" aria-expanded={showThreads}>
        <span className="ts-icon" aria-hidden="true">☰</span>
        <span className="ts-title">{activeThread?.title || 'Silk chat'}</span>
        <span className="ts-caret" aria-hidden="true">▾</span>
      </button>
      <button className="link small" onClick={() => { newChat(); setShowThreads(false); }}>+ New</button>
    </div>
  );

  const threadsPanel = showThreads && (
    <div className="threads-panel">
      <div className="threads-head">
        <strong>Threads</strong>
        <button className="link small" onClick={() => { newChat(); setShowThreads(false); }}>+ New thread</button>
      </div>
      <ul className="threads-list">
        {chats.map((c) => (
          <li key={c.id} className={c.id === activeChatId ? 'active' : ''}>
            <button className="thread-open" onClick={() => openThread(c.id)}>
              <span className="thread-title">{c.title || 'Silk chat'}</span>
              <span className="thread-time">{ago(c.last_message_at || c.created_at)}</span>
            </button>
            <button className="thread-archive" title="Archive thread" aria-label="Archive thread" onClick={() => archiveChat(c.id)}>⌵</button>
          </li>
        ))}
        {chats.length === 0 && <li className="threads-empty muted small">No active threads yet.</li>}
      </ul>
      {archivedChats.length > 0 && (
        <div className="threads-archived">
          <button className="link small" onClick={() => setShowArchived((s) => !s)}>Archived ({archivedChats.length}) {showArchived ? '▴' : '▾'}</button>
          {showArchived && (
            <ul className="threads-list archived">
              {archivedChats.slice(0, 20).map((c) => (
                <li key={c.id} className={c.id === activeChatId ? 'active' : ''}>
                  <button className="thread-open" onClick={() => openThread(c.id)}>
                    <span className="thread-title">{c.title || 'Silk chat'}</span>
                    <span className="thread-time">archived</span>
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
          <div className="bubble">{m.content
            ? m.content
            : (chatBusy && i === messages.length - 1
              ? <span className="silk-thinking">Silk is thinking<i>.</i><i>.</i><i>.</i></span>
              : '')}</div>
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
      {pinnedDraft && (
        <div className="pinned-draft" title="Silk has this draft's content + rationale in context">
          <span>💬 Discussing draft: <strong>{pinnedDraft.target_query}</strong></span>
          <button type="button" className="attach-x" onClick={clearPinnedDraft} aria-label="Stop discussing this draft">×</button>
        </div>
      )}
      {images.length > 0 && (
        <div className="attach-strip">
          {images.map((im, i) => (
            <span key={i} className="attach-chip" title={im.name}>
              🖼 {im.name.length > 16 ? im.name.slice(0, 15) + '…' : im.name}
              <button type="button" className="attach-x" onClick={() => setImages((p) => p.filter((_, k) => k !== i))} aria-label="Remove image">×</button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-row">
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => onFiles(e.target.files)} />
        <button type="button" className="mic-btn" onClick={() => fileRef.current?.click()} aria-label="Attach image" title="Attach image (e.g. a Spotify for Artists screenshot)">📎</button>
        <input ref={inputRef} value={input}
          onChange={(e) => { setInput(e.target.value); setTyping(e.target.value.length > 0); }}
          onBlur={() => setTyping(false)}
          placeholder={images.length ? 'Add a note, or just send the image…' : silkPlaceholder(room, focusNode)} aria-label="Ask Silk" />
        {SpeechRec && (
          <button type="button" className={`mic-btn ${listening ? 'live' : ''}`} onClick={toggleMic} aria-label={listening ? 'Stop dictation' : 'Dictate'} title="Voice input">
            {listening ? '●' : '🎙'}
          </button>
        )}
        <button className="btn sm" type="submit" disabled={chatBusy || (!input.trim() && images.length === 0)}>Send</button>
      </div>
    </form>
  );

  return <><div className="silkchat-head">{header}{threadsPanel}</div>{body}{composer}</>;
}
