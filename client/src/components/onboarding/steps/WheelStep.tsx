import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/rpc";
import { getWheelStyle, WHEEL_STYLE_KEY } from "@/lib/settings-storage";
import { m } from "@/paraglide/messages";

export function WheelStep() {
  const [wheelStyle, setWheelStyle] = useState(() => getWheelStyle());
  const [wheels, setWheels] = useState<Array<{ id: string; name: string; src: string }>>([]);
  useEffect(() => {
    client.api.wheels
      .$get()
      .then((r) => r.json())
      .then(setWheels)
      .catch(() => {});
  }, []);
  function select(src: string) {
    setWheelStyle(src);
    localStorage.setItem(WHEEL_STYLE_KEY, src);
  }
  return (
    <div>
      <h2 className="text-sm font-semibold text-app-text mb-1">{m.ob_wheel_title()}</h2>
      <p className="text-xs text-app-text-muted mb-4">
        {m.ob_wheel_add_hint()} <code className="bg-app-surface-alt px-1 py-0.5 rounded">client/public/wheels/</code>
      </p>
      <div className="grid grid-cols-3 gap-3">
        {wheels.map((w) => (
          <Button
            type="button"
            key={w.id}
            onClick={() => select(w.src)}
            className={`relative w-full min-w-0 !h-auto flex-col !items-stretch !justify-start rounded-lg border p-3 text-left transition-all ${wheelStyle === w.src ? "border-app-accent bg-app-accent/10 ring-1 ring-app-accent/30" : "border-app-border bg-app-surface-alt hover:border-app-border-hover"}`}
          >
            <div className="min-w-0 text-sm font-medium text-app-text truncate">{w.name}</div>
            <div className="mt-2 h-24 flex items-center justify-center rounded-md border border-app-border bg-app-surface overflow-hidden">
              <img src={w.src} alt={w.name} className="h-full max-w-full object-contain" />
            </div>
          </Button>
        ))}
      </div>
    </div>
  );
}
