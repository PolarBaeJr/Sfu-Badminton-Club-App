'use client';

import React, { createContext, useContext, useState, useCallback } from 'react';
import { Toast, ToastViewport } from '@badminton/ui';

interface ToastItem { id: number; message: string; type: 'success' | 'error' | 'info'; }
interface ToastContextType { toast: (message: string, type?: 'success' | 'error' | 'info') => void; }

const ToastContext = createContext<ToastContextType>({ toast: () => {} });
export function useToast() { return useContext(ToastContext); }

let nextId = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
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
