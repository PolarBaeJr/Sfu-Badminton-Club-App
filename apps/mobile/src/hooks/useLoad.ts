import { useCallback, useEffect, useState } from 'react';

export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; data: T };

/**
 * Runs a loader and keeps its result, its failure and its refresh apart. The
 * loaders throw on a failed read, so an error reaches the screen as an error.
 */
export function useLoad<T>(load: () => Promise<T>): {
  state: LoadState<T>;
  refreshing: boolean;
  reload: () => void;
} {
  const [state, setState] = useState<LoadState<T>>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let alive = true;
    load()
      .then((data) => {
        if (alive) setState({ status: 'ready', data });
      })
      .catch((e: unknown) => {
        if (alive) setState({ status: 'error', error: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => {
        if (alive) setRefreshing(false);
      });
    return () => {
      alive = false;
    };
  }, [load, generation]);

  const reload = useCallback(() => {
    setRefreshing(true);
    setGeneration((g) => g + 1);
  }, []);

  return { state, refreshing, reload };
}
