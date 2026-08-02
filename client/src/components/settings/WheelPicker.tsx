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
    <div className="grid grid-cols-3 gap-3 max-w-lg">
      {wheels.map((w) => (
        <Button
          key={w.id}
          onClick={() => onChange(w.src)}
          className={`relative rounded-lg border p-3 text-left transition-all ${
            currentSrc === w.src ? "border-app-accent bg-app-accent/10 ring-1 ring-app-accent/30" : "border-app-border bg-app-surface-alt hover:border-app-border-hover"
          }`}
        >
          <div className="text-sm font-medium text-app-text truncate">{w.name}</div>
          <div className="mt-2 h-20 flex items-center justify-center rounded-md border border-app-border bg-app-surface overflow-hidden">
            <img src={w.src} alt={w.name} className="h-full object-contain" />
          </div>
        </Button>
      ))}
      {wheels.length === 0 && <p className="text-sm text-app-text-muted col-span-3">{m.wheel_no_images()}</p>}
    </div>
  );
}
