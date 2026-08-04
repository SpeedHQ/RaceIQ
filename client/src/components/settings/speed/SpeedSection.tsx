import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useSaveSettings, useSettings } from "@/hooks/settings";
import { m } from "@/paraglide/messages";

export function SpeedSection() {
  const { displaySettings } = useSettings();
  const saveSettings = useSaveSettings();
  const [unitSystem, setUnitSystem] = useState<"metric" | "imperial">(displaySettings.unit);
  const [temperatureUnit, setTemperatureUnit] = useState<"C" | "F">(displaySettings.temperatureUnit);
  const [unitStatus, setUnitStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [unitError, setUnitError] = useState("");
  const tempSettingsJson = JSON.stringify(displaySettings);
  useEffect(() => {
    setUnitSystem(displaySettings.unit);
    setTemperatureUnit(displaySettings.temperatureUnit);
  }, [tempSettingsJson]);
  async function handleUnitSave() {
    setUnitStatus("saving");
    setUnitError("");
    try {
      await saveSettings.mutateAsync({ unit: unitSystem, temperatureUnit });
      setUnitStatus("saved");
      setTimeout(() => setUnitStatus("idle"), 2000);
    } catch (err) {
      setUnitStatus("error");
      setUnitError(err instanceof Error ? err.message : m.label_failed_to_save());
    }
  }
  return (
    <section>
      <h2 className="text-lg font-semibold text-app-text mb-1">{m.label_units()}</h2>
      <p className="text-sm text-app-text-muted mb-4">{m.settings_units_desc()}</p>
      <div className="flex items-center gap-2">
        <Label className="text-app-text-secondary mr-2">{m.settings_units_system_label()}</Label>
        <Button size="sm" variant={unitSystem === "imperial" ? "default" : "outline"} onClick={() => setUnitSystem("imperial")}>
          {m.settings_units_imperial()}
        </Button>
        <Button size="sm" variant={unitSystem === "metric" ? "default" : "outline"} onClick={() => setUnitSystem("metric")}>
          {m.settings_units_metric()}
        </Button>
      </div>
      <div className="mt-5 pt-5 border-t border-app-border">
        <h3 className="text-sm font-semibold text-app-text mb-1">{m.label_temperature()}</h3>
        <p className="text-xs text-app-text-muted mb-3">{m.settings_temperature_desc()}</p>
        <div className="flex items-center gap-2">
          <Label className="text-app-text-secondary mr-2">{m.settings_temperature_unit_label()}</Label>
          <Button size="sm" variant={temperatureUnit === "F" ? "default" : "outline"} onClick={() => setTemperatureUnit("F")}>
            °F
          </Button>
          <Button size="sm" variant={temperatureUnit === "C" ? "default" : "outline"} onClick={() => setTemperatureUnit("C")}>
            °C
          </Button>
        </div>
      </div>
      <div className="mt-4">
        <Button onClick={handleUnitSave} disabled={unitStatus === "saving"}>
          {unitStatus === "saving" ? m.common_saving() : unitStatus === "saved" ? m.common_saved() : m.common_save()}
        </Button>
      </div>
      {unitStatus === "error" && <p className="text-status-danger text-sm mt-2">{unitError}</p>}
    </section>
  );
}
