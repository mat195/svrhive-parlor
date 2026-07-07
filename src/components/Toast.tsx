import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

// Undo toast — every destructive action gets a 5s window to undo (same principle as
// the Foundry retract window). toast(message, undo?) shows a toast; if `undo` is
// given, an Undo button runs it and dismisses.
interface Toast { id: number; message: string; undo?: () => void | Promise<void> }

const Ctx = createContext<{ toast: (message: string, undo?: () => void | Promise<void>) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback((message: string, undo?: () => void | Promise<void>) => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, message, undo }]);
    setTimeout(() => dismiss(id), 5000);
  }, [dismiss]);

  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            <span>{t.message}</span>
            {t.undo && (
              <button className="toast-undo" onClick={async () => { dismiss(t.id); await t.undo!(); }}>Undo</button>
            )}
            <button className="toast-x" aria-label="Dismiss" onClick={() => dismiss(t.id)}>×</button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useToast outside provider');
  return c.toast;
}
