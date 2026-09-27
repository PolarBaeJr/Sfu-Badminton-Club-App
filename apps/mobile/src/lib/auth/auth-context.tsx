import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import type { MobileClient } from '../supabase/client';

interface AuthValue {
  supabase: MobileClient;
  /** undefined while the stored session is still being read on boot. */
  session: Session | null | undefined;
  /** Ends the session on THIS phone only. auth-js defaults to every device. */
  signOut: () => Promise<void>;
  /**
   * Why the member is back on the sign-in screen, when it is not obvious. Held
   * here and not in the screen because a good code signs in first (which
   * unmounts the sign-in screen) and is only then found to have no player row
   * and signed out again, which mounts a fresh one.
   */
  signInNotice: SignInNotice;
  setSignInNotice: (notice: SignInNotice) => void;
}

export type SignInNotice = 'unknown' | 'unfinished' | null;

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ supabase, children }: { supabase: MobileClient; children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [signInNotice, setSignInNotice] = useState<SignInNotice>(null);

  useEffect(() => {
    let alive = true;
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (alive) setSession(data.session);
      })
      .catch(() => {
        if (alive) setSession(null);
      });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      if (alive) setSession(next);
    });
    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, [supabase]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut({ scope: 'local' });
  }, [supabase]);

  return (
    <AuthContext.Provider value={{ supabase, session, signOut, signInNotice, setSignInNotice }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth outside AuthProvider');
  return value;
}
