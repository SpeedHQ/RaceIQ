import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getSteeringLock, getWheelStyle, STEER_LOCK_KEY, WHEEL_STYLE_KEY } from "@/lib/settings-storage";
import { m } from "@/paraglide/messages";
import { WheelPicker } from "../WheelPicker";

export function WheelSection() {
  const [steerLock, setSteerLock] = useState(() => String(getSteeringLock()));
  const [wheelStyle, setWheelStyle] = useState(() => getWheelStyle());
  return (
    <section>
      <h2 className="text-lg font-semibold text-app-text mb-1">{m.settings_wheel_title()}</h2>
      <p className="text-sm text-app-text-muted mb-4">
        {m.settings_wheel_desc()} <code className="text-xs bg-app-surface-alt px-1 py-0.5 rounded">client/public/wheels/</code>
      </p>
      <WheelPicker
        value={wheelStyle}
        onChange={(v) => {
          setWheelStyle(v);
          localStorage.setItem(WHEEL_STYLE_KEY, v);
        }}
      />
      <div className="mt-6 pt-6 border-t border-app-border max-w-xs">
        <Label htmlFor="steer-lock" className="text-app-text-secondary">
          {m.settings_steer_rotation_label()}
        </Label>
        <p className="text-xs text-app-text-muted mb-1.5">{m.settings_steer_rotation_desc()}</p>
        <div className="flex items-end gap-3">
          <Input
            id="steer-lock"
            type="number"
            min={180}
            max={1800}
            step={10}
            value={steerLock}
            onChange={(e) => {
              setSteerLock(e.target.value);
              const val = Number.parseInt(e.target.value, 10);
              if (!Number.isNaN(val) && val >= 180 && val <= 1800) localStorage.setItem(STEER_LOCK_KEY, String(val));
            }}
            className="border bg-app-surface-alt border-app-border-input text-app-text font-mono w-24"
          />
          <span className="text-xs text-app-text-muted mb-2">°</span>
        </div>
      </div>
    </section>
  );
}
