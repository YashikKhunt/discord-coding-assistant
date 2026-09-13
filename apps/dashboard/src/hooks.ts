import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Loads data and optionally refreshes it. While refreshing, the previous data stays on screen
 * (no skeleton flash); errors keep the last good data too.
 */
export function useResource<T>(
  load: () => Promise<T>,
  /** Reload from scratch whenever this key changes (e.g. the serialised filters). */
  key: string,
  options: { refreshMs?: number | ((data: T | null) => number | null) } = {},
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const dataRef = useRef<T | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const next = await loadRef.current();
      dataRef.current = next;
      setData(next);
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the reload trigger
  useEffect(() => {
    dataRef.current = null;
    setData(null);
    void reload();
  }, [key, reload]);

  // Restart polling when the query changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the reload trigger
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const schedule = () => {
      const { refreshMs } = optionsRef.current;
      const ms = typeof refreshMs === "function" ? refreshMs(dataRef.current) : refreshMs;
      if (stopped) return;
      // Re-check every few seconds even when polling is currently off (e.g. a job finished).
      timer = setTimeout(async () => {
        if (ms && document.visibilityState === "visible") await reload();
        schedule();
      }, ms ?? 5_000);
    };
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [key, reload]);

  return { data, error, loading, reload, setData };
}
