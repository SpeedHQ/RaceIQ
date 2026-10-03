import { useLocation } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";

export interface UIWalkthroughProps {
  onClose: () => void;
}

const STEPS = [
  { key: "choose_game", target: '[data-guide="games"]' },
  { key: "live", target: '[data-guide="live"]' },
  { key: "sessions", target: '[data-guide="sessions"]' },
  { key: "compare", target: 'a[href$="/compare"]' },
  { key: "settings", target: '[data-guide="settings"], [data-guide="connection"]' },
] as const;

const COPY = {
  choose_game: [m.guide_choose_game_title, m.guide_choose_game_body],
  live: [m.guide_live_title, m.guide_live_body],
  sessions: [m.guide_sessions_title, m.guide_sessions_body],
  compare: [m.guide_compare_title, m.guide_compare_body],
  settings: [m.guide_settings_title, m.guide_settings_body],
} as const;

export function UIWalkthrough({ onClose }: UIWalkthroughProps) {
  const location = useLocation();
  const [step, setStep] = useState(0);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [rect, setRect] = useState<DOMRect | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => {
      if (returnFocus.current?.isConnected) returnFocus.current.focus();
    };
  }, []);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);

  useEffect(() => {
    const updateTarget = () => {
      const found = Array.from(document.querySelectorAll<HTMLElement>(STEPS[step].target)).find((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.right > 0 && bounds.top < document.documentElement.clientHeight && bounds.left < document.documentElement.clientWidth;
      }) ?? null;
      setTarget(found);
      setRect(found?.getBoundingClientRect() ?? null);
      setViewport({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight });
    };
    const resizeObserver = new ResizeObserver(updateTarget);
    resizeObserver.observe(document.documentElement);
    window.addEventListener("scroll", updateTarget, true);
    const observer = new MutationObserver(updateTarget);
    observer.observe(document.body, { childList: true, subtree: true });
    updateTarget();
    return () => {
      window.removeEventListener("scroll", updateTarget, true);
      resizeObserver.disconnect();
      observer.disconnect();
    };
  }, [step, location.pathname]);

  useEffect(() => {
    target?.setAttribute("data-guide-active", "true");
    return () => target?.removeAttribute("data-guide-active");
  }, [target]);

  const [title, body] = COPY[STEPS[step].key];
  const next = () => step === STEPS.length - 1 ? onClose() : setStep((current) => current + 1);
  const anchored = !!rect && viewport.width >= 640;
  const style = anchored && rect ? {
    position: "fixed" as const,
    top: Math.max(12, Math.min(rect.bottom + 12, viewport.height - 270)),
    left: Math.max(12, Math.min(rect.left, viewport.width - 360)),
    width: "min(340px, calc(100vw - 24px))",
  } : undefined;
  const fallbackClass = anchored ? "" : "fixed bottom-3 right-3 max-h-[calc(100dvh-24px)] overflow-y-auto";

  return (
    <>
      <style>{`[data-guide-active="true"]{outline:2px solid var(--app-accent);outline-offset:3px;border-radius:4px}`}</style>
      <aside ref={panelRef} tabIndex={-1} aria-label={m.guide_title()} className={`z-[100] max-h-[calc(100dvh-24px)] overflow-y-auto w-[min(340px,calc(100vw-24px))] rounded-lg border border-app-border bg-app-surface p-4 text-app-text shadow-lg focus:outline-none ${fallbackClass}`} style={style}>
        <div className="mb-2 flex items-center justify-between gap-3 text-xs text-app-text-muted">
          <span>{m.guide_title()}</span>
          <span>{m.guide_step_count({ current: step + 1, total: STEPS.length })}</span>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label={m.guide_close()}><X /></Button>
        </div>
        <h2 className="text-base font-semibold">{title()}</h2>
        <p className="mt-2 text-sm leading-relaxed text-app-text-muted">{body()}</p>
        {!target && <p className="mt-2 text-xs text-app-text-muted">{m.guide_target_unavailable()}</p>}
        <div className="mt-4 flex justify-between gap-2">
          <Button type="button" variant="ghost" onClick={() => setStep((current) => Math.max(0, current - 1))} disabled={step === 0}>{m.guide_back()}</Button>
          <Button type="button" variant="app-primary" onClick={next}>{step === STEPS.length - 1 ? m.guide_finish() : m.guide_next()}</Button>
        </div>
      </aside>
    </>
  );
}

