import { useEffect, useRef, useState } from "react";

/**
 * Tracks the rendered pixel width of a container element via ResizeObserver,
 * so SVG charts can size their viewBox to the true width instead of a fixed
 * fallback (which letterboxes under `preserveAspectRatio` when the parent is
 * wider/narrower than the viewBox).
 */
export function useMeasuredWidth<T extends HTMLElement>(fallback = 640) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth || fallback);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fallback]);

  return { ref, width };
}
