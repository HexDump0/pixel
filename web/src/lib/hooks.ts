import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";

export interface AsyncState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  /** Update the data locally (e.g. from a live message) without refetching. */
  setData: React.Dispatch<React.SetStateAction<T | undefined>>;
}

/** Load data with `fn` whenever `deps` change; stale responses are ignored. */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(async () => {
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await fnRef.current();
      if (n === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e: any) {
      if (n === seq.current) setError(e.message ?? String(e));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, deps);

  return { data, error, loading, reload, setData };
}

/** Re-render every `ms` (for "x minutes ago" labels). */
export function useTick(ms = 10_000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** Call `fn` at most once per `ms`, trailing. */
export function useThrottled(fn: () => void, ms: number) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      fnRef.current();
    }, ms);
  }, [ms]);
}
