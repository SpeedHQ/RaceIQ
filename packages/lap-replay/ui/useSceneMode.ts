import { useEffect, useState } from "react";

export function useSceneMode<T extends string>(key: string, fallback: T, modes: readonly T[]) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return modes.find((mode) => mode === stored) ?? fallback;
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(key, value); } catch { /* Keep scene controls usable when storage is unavailable. */ }
  }, [key, value]);
  return [value, setValue] as const;
}
