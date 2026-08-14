'use client';

import React, { createContext, useContext, useState, useCallback } from 'react';
import { Toast, ToastViewport, isStaleBuild } from '@badminton/ui';

interface ToastItem { id: number; message: string; type: 'success' | 'error' | 'info'; }
interface ToastContextType { toast: (message: string, type?: 'success' | 'error' | 'info') => void; }

const ToastContext = createContext<ToastContextType>({ toast: () => {} });
export function useToast() { return useContext(ToastContext); }

let nextId = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
    // Once the running build has moved, every server action in this tab is
    // rejected before it reaches a handler, and the ~90 catch blocks that call
    // toast(err.message, 'error') would each raise Next's own wording — "An
    // unexpected response was received from the server." — one red slab per
    // attempt, none of them naming a cause or an action. StaleBuildBanner is
    // already on screen saying exactly what happened and offering the reload
    // that fixes it, so these are noise stacked on top of the answer.
    //
    // The check is a flag read, not a message match: the fetch wrapper sets it
    // from Next's own response header before the error is ever constructed, so
    // it is set by the time any catch block runs. Errors only — a success or an
    // info note still gets through, because something that DID complete locally
    // should still say so.
    if (type === 'error' && isStaleBuild()) return;
    const id = nextId++;
    setToasts((prev) => [...prev, { id, message, type }]);
  }, []);
  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {/* ToastViewport portals to document.body, so a toast no longer depends
          on where this provider sits in the tree to be seen. */}
      <ToastViewport>
        {toasts.map((t) => (
          <Toast key={t.id} message={t.message} type={t.type} onClose={() => remove(t.id)} />
        ))}
      </ToastViewport>
    </ToastContext.Provider>
  );
}
