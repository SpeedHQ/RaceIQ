import { useState, useEffect } from "react";

// Cookie-backed useState — persists value across sessions
export function useCookieState<T>(key: string, defaultValue: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const match = document.cookie.match(new RegExp(`(?:^|; )${key}=([^;]*)`));
      if (match) return JSON.parse(decodeURIComponent(match[1]));
    } catch {
      /* use default */
    }
    return defaultValue;
  });
  useEffect(() => {
    document.cookie = `${key}=${encodeURIComponent(JSON.stringify(value))};path=/;max-age=31536000;SameSite=Lax`;
  }, [key, value]);
  return [value, setValue];
}
