import { createContext, useContext, useState, type ReactNode } from 'react';

export type Room = 'brief' | 'ledger' | 'brain' | 'workshop' | 'watchtower' | 'archive';

interface SilkCtx {
  room: Room;
  setRoom: (r: Room) => void;
  focusNode: string | null;        // Brain node in focus (deep-link / navigation)
  setFocusNode: (n: string | null) => void;
  pointedNode: string | null;      // node Silk is "pointing" at (pulses)
  pointAt: (n: string | null) => void;
  prefill: string;                 // text piped into Silk's input ("Ask Silk about this")
  askSilk: (text: string) => void;
  consumePrefill: () => string;
}

const Ctx = createContext<SilkCtx | null>(null);

export function SilkProvider({ children }: { children: ReactNode }) {
  const [room, setRoom] = useState<Room>('brief');
  const [focusNode, setFocusNode] = useState<string | null>(null);
  const [pointedNode, setPointedNode] = useState<string | null>(null);
  const [prefill, setPrefill] = useState('');

  const pointAt = (n: string | null) => {
    setPointedNode(n);
    if (n) setTimeout(() => setPointedNode((cur) => (cur === n ? null : cur)), 6500);
  };
  const askSilk = (text: string) => setPrefill(text);
  const consumePrefill = () => { const p = prefill; setPrefill(''); return p; };

  return (
    <Ctx.Provider value={{ room, setRoom, focusNode, setFocusNode, pointedNode, pointAt, prefill, askSilk, consumePrefill }}>
      {children}
    </Ctx.Provider>
  );
}

export function useSilk() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSilk outside provider');
  return c;
}

/** Context-aware placeholder for Silk's input, per room + focus. */
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
