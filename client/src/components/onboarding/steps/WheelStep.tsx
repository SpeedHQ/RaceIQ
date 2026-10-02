import { useState } from "react";
import { getWheelStyle, WHEEL_STYLE_KEY } from "@/lib/settings-storage";
import { m } from "@/paraglide/messages";
import { WheelPicker } from "@/components/settings/WheelPicker";
export function WheelStep() {
  const [wheelStyle, setWheelStyle] = useState(() => getWheelStyle());
  return (
    <div>
      <h2 className="text-sm font-semibold text-app-text mb-1">{m.ob_wheel_title()}</h2>
      <p className="text-xs text-app-text-muted mb-4">
        {m.ob_wheel_add_hint()} <code className="bg-app-surface-alt px-1 py-0.5 rounded">client/public/wheels/</code>
      </p>
      <WheelPicker
        value={wheelStyle}
        onChange={(src) => {
          setWheelStyle(src);
          localStorage.setItem(WHEEL_STYLE_KEY, src);
        }}
      />
    </div>
  );
}
