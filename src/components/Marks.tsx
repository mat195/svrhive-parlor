// Placeholder brand marks (swap freely). Palette-aware via currentColor.

export function Spider({ size = 16, className = '' }: { size?: number; className?: string }) {
  // Minimal 8-legged glyph — Silk's presence (parlor callback).
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3"
      strokeLinecap="round" className={className} aria-hidden="true">
      <ellipse cx="12" cy="12" rx="3" ry="3.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="7.4" r="1.5" fill="currentColor" stroke="none" />
      {/* legs */}
      <path d="M9 10 L4 7 M9 12 L3.5 12 M9 14 L4.5 17.5 M10 15.5 L8 20" />
      <path d="M15 10 L20 7 M15 12 L20.5 12 M15 14 L19.5 17.5 M14 15.5 L16 20" />
    </svg>
  );
}

export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`wordmark ${className}`}>
      <span className="wm-svr">Silk Velvet</span>
      <span className="wm-records">Records</span>
    </span>
  );
}
