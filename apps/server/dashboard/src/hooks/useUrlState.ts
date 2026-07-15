import { useCallback, useEffect, useState } from "react";

/**
 * Two-way binding between a single URL search-param and React state.
 *
 * - Initial state is derived from the URL on first render — so refreshes,
 *   shared links and back/forward navigation all keep the same view.
 * - Writes update the URL via history.replaceState (no extra history entries
 *   for filter twiddling) AND set local state.
 * - Listens to popstate so back/forward updates the React state too.
 *
 * `serialize` returning `null` or `""` removes the param from the URL — used
 * to keep the URL minimal when a filter is at its default value.
 */
export function useUrlState<T>(
  key: string,
  defaultValue: T,
  parse: (raw: string | null) => T,
  serialize: (val: T) => string | null,
): [T, (v: T) => void] {
  const read = useCallback((): T => {
    if (typeof window === "undefined") return defaultValue;
    return parse(new URLSearchParams(window.location.search).get(key));
  }, [key, defaultValue, parse]);

  const [value, setValueState] = useState<T>(read);

  const setValue = useCallback(
    (v: T) => {
      setValueState(v);
      if (typeof window === "undefined") return;
      const url = new URL(window.location.href);
      const ser = serialize(v);
      if (ser === null || ser === "") {
        url.searchParams.delete(key);
      } else {
        url.searchParams.set(key, ser);
      }
      window.history.replaceState(null, "", url.toString());
    },
    [key, serialize],
  );

  useEffect(() => {
    const onPop = () => setValueState(read());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [read]);

  return [value, setValue];
}

// ── Common parsers / serializers ────────────────────────────────────────────

export const stringParser = (raw: string | null): string => raw ?? "";
export const stringSerializer = (v: string): string | null => (v ? v : null);

export function nullableStringParser(raw: string | null): string | null {
  return raw && raw.length > 0 ? raw : null;
}
export function nullableStringSerializer(v: string | null): string | null {
  return v;
}

export function boolParser(defaultValue: boolean) {
  return (raw: string | null): boolean => {
    if (raw === null) return defaultValue;
    return raw === "1" || raw === "true";
  };
}
export function boolSerializer(defaultValue: boolean) {
  // Only emit a param when the value differs from the default — keeps URLs short.
  return (v: boolean): string | null => (v === defaultValue ? null : v ? "1" : "0");
}

export function enumParser<T extends string>(allowed: readonly T[], defaultValue: T) {
  return (raw: string | null): T => {
    if (raw && (allowed as readonly string[]).includes(raw)) return raw as T;
    return defaultValue;
  };
}
export function enumSerializer<T extends string>(defaultValue: T) {
  return (v: T): string | null => (v === defaultValue ? null : v);
}
