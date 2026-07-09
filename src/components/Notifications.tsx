import { useSilk, type Room } from '../SilkContext';

// Proactive updates Silk pushed while Mat wasn't watching. Shown at the top of the floating
// widget. Unread first; clicking a card with a room link jumps there and marks it read.
const AGO = (iso: string) => {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const ICON: Record<string, string> = { briefing: '☀', battery: '⚡', 'gate-blocked': '⛔', stall: '⚠', 'job-done': '✓', answer: '✎' };

export default function Notifications() {
  const { notifs, unreadCount, markNotifRead, markAllNotifsRead, setRoom } = useSilk();
  const unread = notifs.filter((n) => !n.read_at);
  if (unread.length === 0) return null; // only surface when there's something new

  const open = (n: { id: string; url: string | null }) => {
    markNotifRead(n.id);
    if (n.url?.startsWith('#/')) {
      const room = n.url.replace('#/', '').split('/')[0] as Room;
      if (room) setRoom(room);
    } else if (n.url) window.open(n.url, '_blank');
  };

  return (
    <div className="silk-notifs">
      <div className="silk-notifs-head">
        <span>Silk pushed {unreadCount} update{unreadCount > 1 ? 's' : ''}</span>
        <button className="link small" onClick={markAllNotifsRead}>mark all read</button>
      </div>
      {unread.slice(0, 5).map((n) => (
        <div key={n.id} className={`silk-notif ${n.priority === 'high' ? 'hi' : ''}`} onClick={() => open(n)} role="button" tabIndex={0}>
          <span className="silk-notif-ic">{ICON[n.kind] ?? '•'}</span>
          <div className="silk-notif-txt">
            <div className="silk-notif-title">{n.title} <span className="muted small">{AGO(n.created_at)}</span></div>
            {n.body && <div className="silk-notif-body">{n.body}</div>}
          </div>
          <button className="attach-x" onClick={(e) => { e.stopPropagation(); markNotifRead(n.id); }} aria-label="Dismiss">×</button>
        </div>
      ))}
    </div>
  );
}
