import { useEffect, useState } from "react";

export const NARROW_VIEWPORT_MAX_WIDTH = 768;

export function isNarrowViewport(width: number): boolean {
  return width <= NARROW_VIEWPORT_MAX_WIDTH;
}

export function useNarrowViewport(): boolean {
  const [isNarrow, setIsNarrow] = useState(() => typeof window !== "undefined" && isNarrowViewport(window.innerWidth));

  useEffect(() => {
    const check = () => setIsNarrow(isNarrowViewport(window.innerWidth));
    check();
    window.addEventListener("resize", check);
    window.addEventListener("orientationchange", check);
    return () => {
      window.removeEventListener("resize", check);
      window.removeEventListener("orientationchange", check);
    };
  }, []);

  return isNarrow;
}
