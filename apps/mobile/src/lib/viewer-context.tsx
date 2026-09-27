import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { useLoad, type LoadState } from '../hooks/useLoad';
import { useAuth } from './auth/auth-context';
import { loadViewer, type Viewer } from './viewer';

interface ViewerValue {
  state: LoadState<Viewer | null>;
  reload: () => void;
}

const ViewerContext = createContext<ViewerValue | null>(null);

/** The signed-in member's own row, read once per session and shared by every tab. */
export function ViewerProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const { supabase } = useAuth();
  const load = useCallback(() => loadViewer(supabase, userId), [supabase, userId]);
  const { state, reload } = useLoad(load);
  return <ViewerContext.Provider value={{ state, reload }}>{children}</ViewerContext.Provider>;
}

export function useViewerState(): ViewerValue {
  const value = useContext(ViewerContext);
  if (!value) throw new Error('useViewerState outside ViewerProvider');
  return value;
}

/** For screens rendered only once the viewer has loaded (see RootNavigator). */
export function useViewer(): Viewer {
  const { state } = useViewerState();
  if (state.status !== 'ready' || !state.data) throw new Error('useViewer before the viewer loaded');
  return state.data;
}
