import { Menu } from "@base-ui/react/menu";
import type { ReactElement, ReactNode } from "react";

export interface DropdownMenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}

interface DropdownMenuProps {
  trigger: ReactNode;
  items: DropdownMenuItem[];
  align?: "left" | "right";
}

const OVERLAY_SURFACE_CLASS = "min-w-[180px] rounded-lg border border-app-border-input bg-app-surface-alt py-1 text-app-text shadow-lg";
const OVERLAY_ITEM_CLASS = "flex w-full cursor-default items-center gap-2 px-3 py-1.5 text-left text-sm outline-none transition-colors data-highlighted:bg-app-accent/10 data-disabled:pointer-events-none data-disabled:opacity-50";

export function DropdownMenu({ trigger, items, align = "right" }: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelRect, setPanelRect] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPanelRect(null);
      return;
    }
    const updateRect = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPanelRect({ top: rect.bottom, left: align === "right" ? rect.right : rect.left });
    };
    updateRect();
    const resizeObserver = new ResizeObserver(updateRect);
    resizeObserver.observe(document.documentElement);
    if (triggerRef.current) resizeObserver.observe(triggerRef.current);
    window.addEventListener("scroll", updateRect, true);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("scroll", updateRect, true);
    };
  }, [open, align]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: wrapper preserves caller-provided trigger element and shared menu positioning
    <div
      ref={triggerRef}
      className="relative inline-block"
      onClick={() => setOpen((o) => !o)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setOpen((o) => !o);
        }
      }}
    >
      {trigger}
      {open &&
        panelRect &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              position: "fixed",
              top: panelRect.top,
              left: panelRect.left,
              transform: align === "right" ? "translateX(-100%)" : undefined,
              marginTop: 4,
            }}
            className="min-w-[180px] rounded-lg bg-app-surface-alt border border-app-border-input z-50 shadow-lg py-1"
          >
            {items.map((item) => (
              <Menu.Item key={item.key} disabled={item.disabled} onClick={item.onClick} className={OVERLAY_ITEM_CLASS}>
                {item.icon}
                <span>{item.label}</span>
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function ReactElementGuard(value: ReactNode): value is ReactElement {
  return typeof value === "object" && value !== null && "type" in value;
}
