import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useSaveSettings, useSettings } from "@/hooks/settings";
import { m } from "@/paraglide/messages";

export function UnitsStep() {
  const { displaySettings } = useSettings();
  const saveSettings = useSaveSettings();
  const [unitSystem, setUnitSystem] = useState<"metric" | "imperial">(displaySettings.unit);
  const [temperatureUnit, setTemperatureUnit] = useState<"C" | "F">(displaySettings.temperatureUnit);
  async function saveUnitSettings(next: { unit?: "metric" | "imperial"; temperatureUnit?: "C" | "F" }) {
    try {
      await saveSettings.mutateAsync({ unit: next.unit ?? unitSystem, temperatureUnit: next.temperatureUnit ?? temperatureUnit });
    } catch {
      /* silent */
    }
  }
  async function selectUnit(unit: "metric" | "imperial") {
    setUnitSystem(unit);
    await saveUnitSettings({ unit });
  }
  async function selectTemperatureUnit(next: "C" | "F") {
    setTemperatureUnit(next);
    await saveUnitSettings({ temperatureUnit: next });
  }
  return (
    <div>
      <h2 className="text-sm font-semibold text-app-text mb-1">{m.label_units()}</h2>
      <p className="text-sm text-app-text-muted mb-4">{m.ob_units_desc()}</p>
      <div className="grid grid-cols-2 gap-3">
        <Button
          type="button"
          onClick={() => selectUnit("imperial")}
          className={`rounded-lg border p-4 text-left transition-all ${unitSystem === "imperial" ? "border-app-accent bg-app-accent/10 ring-1 ring-app-accent/30" : "border-app-border bg-app-surface-alt hover:border-app-border-hover"}`}
        >
          <div className="text-sm font-medium text-app-text">{m.ob_units_imperial()}</div>
          <div className="text-xs text-app-text-muted mt-1">mph, ft, lb</div>
        </Button>
        <Button
          type="button"
          onClick={() => selectUnit("metric")}
          className={`rounded-lg border p-4 text-left transition-all ${unitSystem === "metric" ? "border-app-accent bg-app-accent/10 ring-1 ring-app-accent/30" : "border-app-border bg-app-surface-alt hover:border-app-border-hover"}`}
        >
          <div className="text-sm font-medium text-app-text">{m.ob_units_metric()}</div>
          <div className="text-xs text-app-text-muted mt-1">km/h, m, kg</div>
        </Button>
      </div>
      <div className="mt-5 pt-5 border-t border-app-border">
        <h3 className="text-sm font-semibold text-app-text mb-1">{m.label_temperature()}</h3>
        <p className="text-xs text-app-text-muted mb-3">{m.ob_units_temperature_desc()}</p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            onClick={() => selectTemperatureUnit("F")}
            className={`rounded-lg border px-4 py-2 text-sm transition-all ${temperatureUnit === "F" ? "border-app-accent bg-app-accent/10 ring-1 ring-app-accent/30" : "border-app-border bg-app-surface-alt hover:border-app-border-hover"}`}
          >
            °F
          </Button>
          <Button
            type="button"
            onClick={() => selectTemperatureUnit("C")}
            className={`rounded-lg border px-4 py-2 text-sm transition-all ${temperatureUnit === "C" ? "border-app-accent bg-app-accent/10 ring-1 ring-app-accent/30" : "border-app-border bg-app-surface-alt hover:border-app-border-hover"}`}
          >
            °C
          </Button>
        </div>
      </div>
    </div>
  );
}
