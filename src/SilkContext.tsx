import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { supabase } from './lib/supabase';
import { streamSilkChat, callFn, type LedgerRef } from './lib/api';

export type Room = 'brief' | 'ledger' | 'brain' | 'workshop' | 'watchtower' | 'archive';
export interface Msg { role: 'user' | 'assistant'; content: string; refs?: LedgerRef[] }
export interface ChatRow { id: string; title: string | null; created_at: string }

const ACTIVE_KEY = 'silk_active_chat';

// Brain nodes Silk can "point" at when he names them in a reply.
const NODE_MAP: [RegExp, string][] = [
  [/\bfrei\b/i, 'collab-frei'], [/\bmuffin\b/i, 'collab-muffin'], [/\bnick nigh\b/i, 'collab-nick-nigh'],
  [/\bsunnie\b/i, 'collab-sunnie'], [/\bmagi merlin\b/i, 'collab-magi-merlin'], [/\bcurtis williams\b/i, 'collab-curtis-williams'],
  [/\bspotify\b/i, 'platform-spotify'], [/\byoutube\b/i, 'platform-youtube'], [/\bbandcamp\b/i, 'platform-bandcamp'],
  [/\bsilk velvet\b/i, 'svr'], [/\blucius p\.? thundercat\b/i, 'lpt'],
];

interface SilkCtx {
  room: Room;
  setRoom: (r: Room) => void;
  focusNode: string | null;
  setFocusNode: (n: string | null) => void;
  pointedNode: string | null;
  pointAt: (n: string | null) => void;
  prefill: string;
  askSilk: (text: string) => void;
  consumePrefill: () => string;
  typing: boolean;
  setTyping: (v: boolean) => void;
  chatBusy: boolean;
  // hoisted chat (persists across ALL navigation + browser restart)
  messages: Msg[];
  chatBooting: boolean;
  chats: ChatRow[];
  activeChatId: string | null;
  sendMessage: (text: string) => Promise<void>;
  newChat: () => Promise<void>;
  loadChat: (id: string) => Promise<void>;
}

const Ctx = createContext<SilkCtx | null>(null);

export function SilkProvider({ children }: { children: ReactNode }) {
  const [room, setRoom] = useState<Room>('brief');
  const [focusNode, setFocusNode] = useState<string | null>(null);
  const [pointedNode, setPointedNode] = useState<string | null>(null);
  const [prefill, setPrefill] = useState('');
  const [typing, setTyping] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);

  const [messages, setMessages] = useState<Msg[]>([]);
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [chatBooting, setChatBooting] = useState(true);

  const pointAt = useCallback((n: string | null) => {
    setPointedNode(n);
    if (n) setTimeout(() => setPointedNode((cur) => (cur === n ? null : cur)), 6500);
  }, []);
  const askSilk = useCallback((text: string) => setPrefill(text), []);
  const prefillRef = useRef(prefill);
  prefillRef.current = prefill;
  const consumePrefill = useCallback(() => { const p = prefillRef.current; setPrefill(''); return p; }, []);

  const loadMessages = useCallback(async (cid: string) => {
    const { data } = await supabase.from('parlor_messages')
      .select('role, content, ledger_refs').eq('chat_id', cid).order('created_at', { ascending: true });
    setMessages((data ?? []).filter((m: any) => m.role !== 'system').map((m: any) => ({ role: m.role, content: m.content, refs: m.ledger_refs })));
  }, []);
  const refreshChats = useCallback(async () => {
    const { data } = await supabase.from('parlor_chats').select('id, title, created_at').order('created_at', { ascending: false });
    setChats((data as ChatRow[]) ?? []);
  }, []);

  // On mount: restore the active chat (localStorage → else latest) + its messages.
  useEffect(() => {
    (async () => {
      await refreshChats();
      let cid = localStorage.getItem(ACTIVE_KEY);
      if (cid) {
        const { data } = await supabase.from('parlor_chats').select('id').eq('id', cid).maybeSingle();
        if (!data) cid = null; // stored chat was deleted
      }
      if (!cid) {
        const { data } = await supabase.from('parlor_chats').select('id').order('created_at', { ascending: false }).limit(1);
        cid = data?.[0]?.id ?? null;
      }
      if (cid) { setActiveChatId(cid); localStorage.setItem(ACTIVE_KEY, cid); await loadMessages(cid); }
      setChatBooting(false);
    })();
  }, [loadMessages, refreshChats]);

  // Ambient distiller trigger (Brief Six): after a chat settles (60s idle) or Mat
  // navigates away / closes, distill the conversation into proposed extractions.
  // Runs in the background — never interrupts Mat's flow.
  const distillTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const distillFor = useRef<string | null>(null);
  const flushDistill = useCallback((trigger: string) => {
    if (distillTimer.current) { clearTimeout(distillTimer.current); distillTimer.current = null; }
    const cid = distillFor.current;
    if (!cid) return;
    distillFor.current = null;
    callFn('conversation-distiller', { chat_id: cid, trigger }).catch(() => {});
  }, []);
  const scheduleDistill = useCallback((cid: string) => {
    distillFor.current = cid;
    if (distillTimer.current) clearTimeout(distillTimer.current);
    distillTimer.current = setTimeout(() => flushDistill('debounce'), 60_000);
  }, [flushDistill]);

  // Flush on tab close / hide (navigation away from the Parlor).
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flushDistill('navigation'); };
    window.addEventListener('beforeunload', () => flushDistill('navigation'));
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [flushDistill]);

  const ensureChat = useCallback(async (): Promise<string> => {
    if (activeChatId) return activeChatId;
    const { data } = await supabase.from('parlor_chats').insert({ title: 'Silk chat' }).select('id').single();
    const id = data!.id as string;
    setActiveChatId(id); localStorage.setItem(ACTIVE_KEY, id); refreshChats();
    return id;
  }, [activeChatId, refreshChats]);

  const sendMessage = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t || chatBusy) return;
    const id = await ensureChat();
    await supabase.from('parlor_messages').insert({ chat_id: id, role: 'user', content: t });
    setMessages((m) => [...m, { role: 'user', content: t }, { role: 'assistant', content: '', refs: [] }]);
    setChatBusy(true);
    try {
      const { text: full } = await streamSilkChat({
        chatId: id, message: t,
        onRefs: (refs) => setMessages((m) => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], refs }; return c; }),
        onDelta: (d) => setMessages((m) => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], content: c[c.length - 1].content + d }; return c; }),
      });
      const hit = NODE_MAP.find(([re]) => re.test(full));
      if (hit) pointAt(hit[1]);
    } catch (e) {
      setMessages((m) => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], content: c[c.length - 1].content || `[error: ${e instanceof Error ? e.message : e}]` }; return c; });
    } finally { setChatBusy(false); scheduleDistill(id); }
  }, [chatBusy, ensureChat, pointAt, scheduleDistill]);

  const newChat = useCallback(async () => {
    flushDistill('navigation'); // distill the chat we're leaving
    const { data } = await supabase.from('parlor_chats').insert({ title: 'Silk chat' }).select('id').single();
    const id = data!.id as string;
    setActiveChatId(id); localStorage.setItem(ACTIVE_KEY, id); setMessages([]); refreshChats();
  }, [refreshChats, flushDistill]);

  const loadChat = useCallback(async (id: string) => {
    flushDistill('navigation'); // distill the chat we're leaving before switching
    setActiveChatId(id); localStorage.setItem(ACTIVE_KEY, id); await loadMessages(id);
  }, [loadMessages, flushDistill]);

  return (
    <Ctx.Provider value={{
      room, setRoom, focusNode, setFocusNode, pointedNode, pointAt, prefill, askSilk, consumePrefill,
      typing, setTyping, chatBusy,
      messages, chatBooting, chats, activeChatId, sendMessage, newChat, loadChat,
    }}>
      {children}
    </Ctx.Provider>
  );
}

export function useSilk() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSilk outside provider');
  return c;
}

export function silkPlaceholder(room: Room, focusNode: string | null): string {
  if (room === 'brain' && focusNode) {
    if (focusNode.startsWith('collab-')) return `Who is ${focusNode.replace('collab-', '')}? What does this collaboration tell us?`;
    if (focusNode.startsWith('platform-')) return `Is ${focusNode.replace('platform-', '')} consistent with our bio?`;
    return `Ask about ${focusNode}…`;
  }
  switch (room) {
    case 'brief': return 'Why did lofi drop?';
    case 'workshop': return 'Draft a page for a target query…';
    case 'ledger': return 'Ask about anything in the ledger…';
    case 'watchtower': return 'Any AI referrers yet?';
    case 'archive': return 'What did we supersede, and why?';
    default: return 'Ask Silk…';
  }
}
