import { useCallback, useRef } from "react";

/**
 * Out-of-order guard for loads: `const isCurrent = begin()` before a request, then update state only if
 * `isCurrent()` — a slow answer for the previous tab or filter never overwrites the current one.
 */
export function useLatest() {
  const seq = useRef(0);
  return useCallback(() => {
    const id = ++seq.current;
    return () => id === seq.current;
  }, []);
}
