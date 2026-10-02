import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { useCallback } from "react";
export function AnalyseResizeHandle({ topHeight, onHeightChange }: { topHeight: number; onHeightChange: (height: number | ((height: number) => number)) => void }) {
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLHRElement>) => {
      if (event.key === "ArrowUp") {
        event.preventDefault();
        onHeightChange((height) => Math.max(250, height - 10));
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        onHeightChange((height) => Math.min(800, height + 10));
      }
    },
    [onHeightChange],
  );
  const handleMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLHRElement>) => {
      event.preventDefault();
      const startY = event.clientY;
      const startH = topHeight;
      const onMove = (moveEvent: MouseEvent) => onHeightChange(Math.max(250, Math.min(800, startH + moveEvent.clientY - startY)));
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [topHeight, onHeightChange],
  );
  return (
    <hr
      aria-orientation="horizontal"
      aria-valuemin={250}
      aria-valuemax={800}
      aria-valuenow={topHeight}
      tabIndex={0}
      className="hidden h-3 shrink-0 cursor-row-resize items-center justify-center border-y border-app-border bg-app-surface-alt/80 transition-colors hover:bg-app-accent/30 @5xl/workspace:flex"
      onKeyDown={handleKeyDown}
      onMouseDown={handleMouseDown}
    />
  );
}
