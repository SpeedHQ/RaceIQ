import { useEffect, useState } from "react";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { Button } from "../ui/button";

interface WheelOption {
  id: string;
  name: string;
  src: string;
}

export function WheelPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [wheels, setWheels] = useState<WheelOption[]>([]);

  useEffect(() => {
    client.api.wheels
      .$get()
      .then((r) => r.json())
      .then(setWheels)
      .catch(() => {});
  }, []);

  const currentSrc = value;

  return (
    <div className="grid max-w-3xl grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-3">
      {wheels.map((w) => (
        <Button
          type="button"
          key={w.id}
          onClick={() => onChange(w.src)}
          className={`relative w-full min-w-0 !h-auto flex-col !items-stretch !justify-start rounded-lg border p-3 text-left transition-all ${
            currentSrc === w.src ? "border-app-accent bg-app-accent/10 ring-1 ring-app-accent/30" : "border-app-border bg-app-surface-alt hover:border-app-border-hover"
          }`}
        >
          <div className="min-w-0 whitespace-normal break-words text-sm font-medium text-app-text">{w.name}</div>
          <div className="mt-2 h-24 flex items-center justify-center rounded-md border border-app-border bg-app-surface overflow-hidden">
            <img src={w.src} alt={w.name} className="h-full max-w-full object-contain" />
          </div>
        </Button>
      ))}
      {wheels.length === 0 && <p className="text-sm text-app-text-muted">{m.wheel_no_images()}</p>}
    </div>
  );
}
