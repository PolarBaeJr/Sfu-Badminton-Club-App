'use client';

import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { Dialog } from './Dialog';
import { Button } from './Button';

export interface ConfirmOptions {
  title?: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within a ConfirmProvider');
  return ctx;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((o) => {
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setOpts(o);
    });
  }, []);

  const settle = useCallback((result: boolean) => {
    resolver.current?.(result);
    resolver.current = null;
    setOpts(null);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={!!opts} onClose={() => settle(false)} title={opts?.title ?? 'Are you sure?'}>
        <div className="space-y-5">
          <div className="text-sm text-[var(--text-muted)]">{opts?.message}</div>
          <div className="flex items-center justify-between pt-1">
            <Button variant="ghost" onClick={() => settle(false)}>{opts?.cancelLabel ?? 'Cancel'}</Button>
            <Button variant={opts?.danger ? 'danger' : 'primary'} onClick={() => settle(true)}>
              {opts?.confirmLabel ?? 'Confirm'}
            </Button>
          </div>
        </div>
      </Dialog>
    </ConfirmContext.Provider>
  );
}
