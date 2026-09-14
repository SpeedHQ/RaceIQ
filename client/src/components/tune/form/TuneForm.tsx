import type { TuneCategory } from "@shared/racing/tuning/types";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { TuneSettings } from "@/data/tune-catalog";
import { useSettings } from "@/hooks/settings";
import { m } from "@/paraglide/messages";
import { withDefaults } from "./defaults";
import { TuneInfoSection } from "./TuneInfoSection";
import { TuneSettingsFields } from "./TuneSettingsFields";
import type { TuneFormData } from "./types";
import { type ConvCategory, fromDisplay, toDisplay, unitLabel } from "./units";
import { useAllCars } from "./useAllCars";

export { withDefaults } from "./defaults";
export type { TuneFormData } from "./types";

export function TuneForm({
  initialData,
  onSubmit,
  onCancel,
  title,
  isSubmitting,
}: {
  initialData?: Partial<TuneFormData>;
  onSubmit: (data: TuneFormData) => void;
  onCancel: () => void;
  title: string;
  isSubmitting: boolean;
}) {
  const [name, setName] = useState(initialData?.name ?? "");
  const [author, setAuthor] = useState(initialData?.author ?? m.tune_me());
  const [carOrdinal, setCarOrdinal] = useState(initialData?.carOrdinal ?? 2860);
  const [category, setCategory] = useState<TuneCategory>(initialData?.category ?? "circuit");
  const [description, setDescription] = useState(initialData?.description ?? "");
  const [settings, setSettings] = useState<TuneSettings>(withDefaults(initialData?.settings));
  const [drivetrain, setDrivetrain] = useState<"rwd" | "fwd" | "awd">(initialData?.settings?.drivetrain ?? "rwd");
  const [activeTab, setActiveTab] = useState<"info" | "settings">("settings");
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");
  const { displaySettings } = useSettings();
  const [isMetric, setIsMetric] = useState(() => {
    const u = initialData?.settings?.springs?.unit;
    const au = initialData?.settings?.aero?.unit;
    if (u || au) return u !== "lb/in" && au !== "lb";
    if (initialData?.unitSystem) return initialData.unitSystem !== "imperial";
    return displaySettings.unit !== "imperial";
  });
  const [carSearchQuery, setCarSearchQuery] = useState("");
  const [carDropOpen, setCarDropOpen] = useState(false);
  const { data: allCars = [] } = useAllCars();

  const filteredFormCars = carSearchQuery ? allCars.filter((c) => c.name.toLowerCase().includes(carSearchQuery.toLowerCase())).slice(0, 20) : allCars.slice(0, 20);

  const selectedCarName = allCars.find((c) => c.ordinal === carOrdinal)?.name ?? (carOrdinal ? `Car #${carOrdinal}` : "");

  useEffect(() => {
    setName(initialData?.name ?? "");
    setAuthor(initialData?.author ?? m.tune_me());
    setCarOrdinal(initialData?.carOrdinal ?? 2860);
    setCategory(initialData?.category ?? "circuit");
    setDescription(initialData?.description ?? "");
    setSettings(withDefaults(initialData?.settings));
    setDrivetrain(initialData?.settings?.drivetrain ?? "rwd");
    setActiveTab("info");
    setJsonMode(false);
    setJsonText("");
    setJsonError("");
    const u = initialData?.settings?.springs?.unit;
    const au = initialData?.settings?.aero?.unit;
    if (u || au) {
      setIsMetric(u !== "lb/in" && au !== "lb");
    } else if (initialData?.unitSystem) {
      setIsMetric(initialData.unitSystem !== "imperial");
    } else {
      setIsMetric(displaySettings.unit !== "imperial");
    }
  }, [initialData, displaySettings.unit]);

  const updateSettings = <K extends keyof TuneSettings>(group: K, field: string, value: number) => {
    setSettings((prev) => ({
      ...prev,
      [group]: { ...(prev[group] as object), [field]: value },
    }));
  };

  const switchUnitSystem = (nextIsMetric: boolean) => {
    if (nextIsMetric === isMetric) return;
    setSettings((prev) => {
      const convert = (value: number, cat: ConvCategory) => (nextIsMetric ? fromDisplay(value, cat, false) : toDisplay(value, cat, false));
      return {
        ...prev,
        tires: {
          ...prev.tires,
          frontPressure: convert(prev.tires.frontPressure, "tires"),
          rearPressure: convert(prev.tires.rearPressure, "tires"),
        },
        springs: {
          ...prev.springs,
          frontRate: convert(prev.springs.frontRate, "springs"),
          rearRate: convert(prev.springs.rearRate, "springs"),
          frontHeight: convert(prev.springs.frontHeight, "height"),
          rearHeight: convert(prev.springs.rearHeight, "height"),
        },
        rollCenterHeight: {
          front: convert(prev.rollCenterHeight.front, "height"),
          rear: convert(prev.rollCenterHeight.rear, "height"),
        },
        aero: {
          ...prev.aero,
          frontDownforce: convert(prev.aero.frontDownforce, "aero"),
          rearDownforce: convert(prev.aero.rearDownforce, "aero"),
        },
      };
    });
    setIsMetric(nextIsMetric);
  };

  const parseTuneJson = (rawText: string) => {
    const parsed = JSON.parse(rawText);
    const s = parsed.settings ?? parsed;
    const required = ["tires", "gearing", "alignment", "antiRollBars", "springs", "damping", "aero", "differential", "brakes"];
    for (const key of required) {
      if (!s[key]) throw new Error(`Missing section: ${key}`);
    }
    const normalizedSettings = {
      ...s,
      springs: {
        ...s.springs,
        ...(parsed.unitSystem === "imperial" ? { unit: "lb/in" } : parsed.unitSystem === "metric" ? { unit: "kgf/mm" } : {}),
      },
      aero: {
        ...s.aero,
        ...(parsed.unitSystem === "imperial" ? { unit: "lb" } : parsed.unitSystem === "metric" ? { unit: "kgf" } : {}),
      },
    };
    setSettings(withDefaults(normalizedSettings));
    const isImperialByPayload = parsed.unitSystem === "imperial";
    setIsMetric(isImperialByPayload ? false : s.springs?.unit !== "lb/in" && s.aero?.unit !== "lb");
    if (parsed.name) setName(parsed.name);
    if (parsed.author) setAuthor(parsed.author);
    if (parsed.category) setCategory(parsed.category);
    if (parsed.description) setDescription(parsed.description);
    setJsonError("");
    setJsonMode(false);
  };

  const handleJsonParse = () => {
    try {
      parseTuneJson(jsonText);
    } catch (err: unknown) {
      setJsonError(err instanceof Error ? err.message : m.tune_form_error_invalid_json());
    }
  };

  const handleJsonFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setJsonText(text);
      parseTuneJson(text);
    } catch (err: unknown) {
      setJsonError(err instanceof Error ? err.message : m.tune_form_error_invalid_json_file());
    }
    e.target.value = "";
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const savedSettings: TuneSettings = {
      ...settings,
      drivetrain,
      springs: { ...settings.springs, unit: unitLabel("springs", isMetric) },
      aero: { ...settings.aero, unit: unitLabel("aero", isMetric) },
    };
    onSubmit({
      gameId: "fm-2023",
      name,
      author,
      carOrdinal,
      category,
      description,
      settings: savedSettings,
      unitSystem: isMetric ? "metric" : "imperial",
    });
  };

  const tabCls = (tab: "info" | "settings") =>
    `px-3 py-1 text-xs font-medium rounded transition-colors ${activeTab === tab ? "bg-app-accent/15 text-app-accent" : "text-app-text-muted hover:text-app-text"}`;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col min-h-full">
      {/* Sticky header — title, tabs, and actions in one bar */}
      <div className="sticky top-0 z-10 bg-app-bg border-b border-app-border flex items-center gap-3 px-4 py-2">
        <Button variant="app-ghost" size="app-sm" onClick={onCancel}>
          &larr;
        </Button>
        <h2 className="text-sm font-semibold text-app-text">{title}</h2>
        <div className="flex items-center gap-1 ml-2">
          <Button variant="app-ghost" size="app-sm" className={tabCls("info")} onClick={() => setActiveTab("info")}>
            {m.tune_form_tab_info()}
          </Button>
          <Button variant="app-ghost" size="app-sm" className={tabCls("settings")} onClick={() => setActiveTab("settings")}>
            {m.tune_form_tab_settings()}
          </Button>
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <Button variant="app-outline" size="app-sm" onClick={onCancel}>
            {m.common_cancel()}
          </Button>
          <Button type="submit" variant="app-primary" size="app-sm" disabled={!name || isSubmitting}>
            {isSubmitting ? m.common_saving() : m.tune_form_button_save_tune()}
          </Button>
        </div>
      </div>

      {/* Info tab */}
      {activeTab === "info" && (
        <TuneInfoSection
          allCars={allCars}
          carOrdinal={carOrdinal}
          carDropOpen={carDropOpen}
          carSearchQuery={carSearchQuery}
          filteredFormCars={filteredFormCars}
          selectedCarName={selectedCarName}
          setCarOrdinal={setCarOrdinal}
          setCarDropOpen={setCarDropOpen}
          setCarSearchQuery={setCarSearchQuery}
          name={name}
          setName={setName}
          author={author}
          setAuthor={setAuthor}
          category={category}
          setCategory={setCategory}
          drivetrain={drivetrain}
          setDrivetrain={setDrivetrain}
          description={description}
          setDescription={setDescription}
        />
      )}

      {/* Settings tab */}
      {activeTab === "settings" && (
        <div className="p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-app-text-muted">{m.tuneform_tune_parameters()}</h3>
            <div className="flex items-center gap-2">
              <Button type="button" onClick={() => setJsonMode(false)} className="hidden">
                {m.tune_json_import()}
              </Button>
              {!jsonMode && (
                <div className="flex rounded-md ring-1 ring-app-border overflow-hidden">
                  <Button
                    variant="app-ghost"
                    size="app-sm"
                    onClick={() => switchUnitSystem(true)}
                    className={`!rounded-none !px-2.5 !py-1 font-semibold transition-colors ${isMetric ? "bg-app-accent/20 text-app-accent" : "text-app-text-muted hover:text-app-text-secondary"}`}
                  >
                    {m.tune_metric()}
                  </Button>
                  <Button
                    variant="app-ghost"
                    size="app-sm"
                    onClick={() => switchUnitSystem(false)}
                    className={`!rounded-none !px-2.5 !py-1 font-semibold transition-colors ${!isMetric ? "bg-app-accent/20 text-app-accent" : "text-app-text-muted hover:text-app-text-secondary"}`}
                  >
                    {m.tune_imperial()}
                  </Button>
                </div>
              )}
            </div>
          </div>

          {jsonMode ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <label className="text-xs px-3 py-1.5 rounded bg-app-surface ring-1 ring-app-border text-app-text cursor-pointer hover:bg-app-surface-hover transition-colors">
                  {m.tuneform_import_json_file()}
                  <input type="file" accept=".json,application/json" onChange={handleJsonFileImport} className="hidden" />
                </label>
              </div>
              <textarea
                value={jsonText}
                onChange={(e) => {
                  setJsonText(e.target.value);
                  setJsonError("");
                }}
                placeholder={m.tune_form_paste_json_placeholder()}
                rows={10}
                className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-xs text-app-text font-mono focus:outline-none focus:ring-1 focus:ring-app-accent resize-y"
              />
              {jsonError && <p className="text-xs text-status-danger">{jsonError}</p>}
              <Button variant="app-primary" size="app-sm" onClick={handleJsonParse}>
                {m.tune_parse_populate()}
              </Button>
            </div>
          ) : (
            <TuneSettingsFields settings={settings} isMetric={isMetric} allCars={allCars} carOrdinal={carOrdinal} drivetrain={drivetrain} updateSettings={updateSettings} setSettings={setSettings} />
          )}
        </div>
      )}
    </form>
  );
}
