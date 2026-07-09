import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { supabase } from './lib/supabase';
import { streamSilkChat, callFn, type LedgerRef } from './lib/api';

export type Room = 'brief' | 'ledger' | 'brain' | 'people' | 'workshop' | 'watchtower' | 'archive' | 'rules';
export interface Msg { role: 'user' | 'assistant'; content: string; refs?: LedgerRef[] }
export interface ChatRow { id: string; title: string | null; created_at: string }
export interface Notif { id: string; kind: string; title: string; body: string | null; url: string | null; priority: 'normal' | 'high'; read_at: string | null; created_at: string }

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
  // "Discuss this draft" — a corpus draft pinned as the chat's subject (Workshop → chat).
  pinnedDraft: { id: string; target_query: string } | null;
  discussDraft: (d: { id: string; target_query: string }) => void;
  clearPinnedDraft: () => void;
  draftsRev: number; // bumps when a chat revision may have changed a draft → Foundry reloads
  chatOpen: boolean;                    // floating widget open/closed
  setChatOpen: (v: boolean) => void;
  // Proactive updates Silk pushes (briefing, battery, gate-blocked, stalls). Surfaced as a
  // widget badge + list — this is Silk contributing while Mat isn't watching.
  notifs: Notif[];
  unreadCount: number;
  markNotifRead: (id: string) => Promise<void>;
  markAllNotifsRead: () => Promise<void>;
  typing: boolean;
  setTyping: (v: boolean) => void;
  chatBusy: boolean;
  // hoisted chat (persists across ALL navigation + browser restart)
  messages: Msg[];
  chatBooting: boolean;
  chats: ChatRow[];
  activeChatId: string | null;
  sendMessage: (text: string, images?: { media_type: string; data: string }[], pinnedDraftId?: string) => Promise<void>;
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
  const [pinnedDraft, setPinnedDraft] = useState<{ id: string; target_query: string } | null>(null);
  const [draftsRev, setDraftsRev] = useState(0);
  const [chatOpen, setChatOpen] = useState(false);
  const [notifs, setNotifs] = useState<Notif[]>([]);

  const [messages, setMessages] = useState<Msg[]>([]);
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [chatBooting, setChatBooting] = useState(true);

  const pointAt = useCallback((n: string | null) => {
    setPointedNode(n);
    if (n) setTimeout(() => setPointedNode((cur) => (cur === n ? null : cur)), 6500);
  }, []);
  const askSilk = useCallback((text: string) => setPrefill(text), []);
  const clearPinnedDraft = useCallback(() => setPinnedDraft(null), []);
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

  // Proactive updates: load recent notifications + live-subscribe to new pushes. Silk pings
  // here from cron jobs and background events (briefing, battery-complete, gate-blocked, stalls).
  const refreshNotifs = useCallback(async () => {
    const { data } = await supabase.from('silk_notifications').select('*').order('created_at', { ascending: false }).limit(30);
    setNotifs((data as Notif[]) ?? []);
  }, []);
  useEffect(() => {
    refreshNotifs();
    const ch = supabase.channel('silk_notifs')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'silk_notifications' },
        (payload) => setNotifs((cur) => [payload.new as Notif, ...cur].slice(0, 30)))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [refreshNotifs]);
  const markNotifRead = useCallback(async (id: string) => {
    setNotifs((cur) => cur.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n)));
    await supabase.from('silk_notifications').update({ read_at: new Date().toISOString() }).eq('id', id);
  }, []);
  const markAllNotifsRead = useCallback(async () => {
    const now = new Date().toISOString();
    setNotifs((cur) => cur.map((n) => (n.read_at ? n : { ...n, read_at: now })));
    await supabase.from('silk_notifications').update({ read_at: now }).is('read_at', null);
  }, []);

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

  const sendMessage = useCallback(async (text: string, images?: { media_type: string; data: string }[], pinnedDraftIdOverride?: string) => {
    const t = text.trim();
    if ((!t && !(images && images.length)) || chatBusy) return;
    const id = await ensureChat();
    const stored = t || (images && images.length ? `📎 ${images.length} image${images.length > 1 ? 's' : ''} attached` : '');
    await supabase.from('parlor_messages').insert({ chat_id: id, role: 'user', content: stored });
    setMessages((m) => [...m, { role: 'user', content: stored }, { role: 'assistant', content: '', refs: [] }]);
    setChatBusy(true);
    try {
      const { text: full } = await streamSilkChat({
        chatId: id, message: t, images, pinnedDraftId: pinnedDraftIdOverride ?? pinnedDraft?.id,
        onRefs: (refs) => setMessages((m) => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], refs }; return c; }),
        onDelta: (d) => setMessages((m) => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], content: c[c.length - 1].content + d }; return c; }),
      });
      const hit = NODE_MAP.find(([re]) => re.test(full));
      if (hit) pointAt(hit[1]);
      // A pinned-draft turn may have applied a revise_draft — refresh the Workshop drafts.
      if (pinnedDraft) setDraftsRev((r) => r + 1);
    } catch (e) {
      setMessages((m) => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], content: c[c.length - 1].content || `[error: ${e instanceof Error ? e.message : e}]` }; return c; });
    } finally { setChatBusy(false); scheduleDistill(id); }
  }, [chatBusy, ensureChat, pointAt, scheduleDistill, pinnedDraft]);

  // Immediate-send: clicking "Discuss this draft" opens the widget AND fires the opening message
  // right away — no text field for Mat to then send. The draft id is threaded explicitly because
  // the pinnedDraft state hasn't flushed yet when we send.
  const discussDraft = useCallback((d: { id: string; target_query: string }) => {
    setPinnedDraft(d);
    setChatOpen(true);
    sendMessage(`Let's go over the "${d.target_query}" draft — give me a quick read, and flag anything you'd change.`, undefined, d.id);
  }, [sendMessage]);

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
      pinnedDraft, discussDraft, clearPinnedDraft, draftsRev, chatOpen, setChatOpen,
      notifs, unreadCount: notifs.filter((n) => !n.read_at).length, markNotifRead, markAllNotifsRead,
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
