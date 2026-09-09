import type { TuneCategory } from "@shared/racing/tuning/types";
import type { Dispatch, SetStateAction } from "react";
import { AppInput } from "@/components/ui/AppInput";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useSettings } from "@/hooks/settings";
import { m } from "@/paraglide/messages";
import { ALL_CATEGORIES, CATEGORY_LABELS } from "../tune-constants";
import type { TuneFormCar } from "./useAllCars";

export function TuneInfoSection({
  allCars,
  carOrdinal,
  carDropOpen,
  carSearchQuery,
  filteredFormCars,
  selectedCarName,
  setCarOrdinal,
  setCarDropOpen,
  setCarSearchQuery,
  name,
  setName,
  author,
  setAuthor,
  category,
  setCategory,
  drivetrain,
  setDrivetrain,
  description,
  setDescription,
}: {
  allCars: TuneFormCar[];
  carOrdinal: number;
  carDropOpen: boolean;
  carSearchQuery: string;
  filteredFormCars: TuneFormCar[];
  selectedCarName: string;
  setCarOrdinal: Dispatch<SetStateAction<number>>;
  setCarDropOpen: Dispatch<SetStateAction<boolean>>;
  setCarSearchQuery: Dispatch<SetStateAction<string>>;
  name: string;
  setName: Dispatch<SetStateAction<string>>;
  author: string;
  setAuthor: Dispatch<SetStateAction<string>>;
  category: TuneCategory;
  setCategory: Dispatch<SetStateAction<TuneCategory>>;
  drivetrain: "rwd" | "fwd" | "awd";
  setDrivetrain: Dispatch<SetStateAction<"rwd" | "fwd" | "awd">>;
  description: string;
  setDescription: Dispatch<SetStateAction<string>>;
}) {
  const { displaySettings } = useSettings();
  const specsMetric = displaySettings.unit !== "imperial";
  return (
    <div className="p-6 grid grid-cols-2 gap-4 max-w-2xl">
      <label className="col-span-2 space-y-1">
        <span className="text-xs font-medium text-app-text-muted">{m.tune_form_name()}</span>
        <AppInput
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="w-full"
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium text-app-text-muted">{m.label_author()}</span>
        <AppInput
          type="text"
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          required
          className="w-full"
        />
      </label>
      <div className="space-y-1 relative">
        <span className="text-xs font-medium text-app-text-muted">{m.label_car()}</span>
        <AppInput
          type="text"
          value={carDropOpen ? carSearchQuery : selectedCarName || m.tune_form_select_car_placeholder()}
          onChange={(e) => {
            setCarSearchQuery(e.target.value);
            setCarDropOpen(true);
          }}
          onFocus={() => {
            setCarDropOpen(true);
            setCarSearchQuery("");
          }}
          onBlur={() => setTimeout(() => setCarDropOpen(false), 150)}
          placeholder={m.tune_form_search_car_placeholder()}
          className="w-full"
        />
        {carDropOpen && (
          <div className="absolute left-0 right-0 mt-1 max-h-48 overflow-auto rounded-lg bg-app-surface border border-app-border z-50 shadow-lg">
            {filteredFormCars.map((c) => (
              <Button
                key={c.ordinal}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setCarOrdinal(c.ordinal);
                  setCarSearchQuery("");
                  setCarDropOpen(false);
                }}
                className={`w-full text-left px-3 py-1.5 text-xs hover:bg-app-accent/20 transition-colors ${carOrdinal === c.ordinal ? "text-app-accent" : "text-app-text"}`}
              >
                {c.name}
              </Button>
            ))}
            {filteredFormCars.length === 0 && <div className="px-3 py-2 text-xs text-app-text-muted">{m.tune_no_cars_found()}</div>}
          </div>
        )}
      </div>
      <label className="space-y-1">
        <span className="text-xs font-medium text-app-text-muted">{m.label_category()}</span>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as TuneCategory)}
          className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
        >
          {ALL_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium text-app-text-muted">{m.label_drivetrain()}</span>
        <select
          value={drivetrain}
          onChange={(e) => setDrivetrain(e.target.value as "rwd" | "fwd" | "awd")}
          className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
        >
          <option value="rwd">RWD</option>
          <option value="fwd">FWD</option>
          <option value="awd">AWD</option>
        </select>
      </label>
      <label className="col-span-2 space-y-1">
        <span className="text-xs font-medium text-app-text-muted">{m.tune_form_description()}</span>
        <AppInput
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full"
        />
      </label>
      {(() => {
        const carData = allCars.find((c) => c.ordinal === carOrdinal);
        if (!carData?.specs) return null;
        const s = carData.specs;
        return (
          <Card className="col-span-2">
            <CardContent className="grid grid-cols-3 gap-x-4 gap-y-2 p-3">
              {s.hp > 0 && (
                <div className="flex flex-col">
                  <span className="text-app-caption text-app-text-muted uppercase tracking-wide">{m.label_power()}</span>
                  <span className="text-xs font-mono text-app-text">{s.hp} hp</span>
                </div>
              )}
              {s.torque > 0 && (
                <div className="flex flex-col">
                  <span className="text-app-caption text-app-text-muted uppercase tracking-wide">{m.label_torque()}</span>
                  <span className="text-xs font-mono text-app-text">{s.torque} lb-ft</span>
                </div>
              )}
              {s.weightKg > 0 && (
                <div className="flex flex-col">
                  <span className="text-app-caption text-app-text-muted uppercase tracking-wide">{m.label_weight()}</span>
                  <span className="text-xs font-mono text-app-text">{s.weightKg} kg</span>
                </div>
              )}
              {s.engine && (
                <div className="flex flex-col">
                  <span className="text-app-caption text-app-text-muted uppercase tracking-wide">{m.label_engine()}</span>
                  <span className="text-xs font-mono text-app-text truncate">
                    {s.engine}
                    {s.aspiration && s.aspiration !== "NA" ? ` · ${s.aspiration}` : ""}
                  </span>
                </div>
              )}
              {s.topSpeedMph > 0 && (
                <div className="flex flex-col">
                  <span className="text-app-caption text-app-text-muted uppercase tracking-wide">{m.label_top_speed()}</span>
                  <span className="text-xs font-mono text-app-text">
                    {specsMetric ? Math.round(s.topSpeedMph * 1.60934) : Math.round(s.topSpeedMph)} {specsMetric ? "km/h" : "mph"}
                  </span>
                </div>
              )}
              {s.division && (
                <div className="flex flex-col">
                  <span className="text-app-caption text-app-text-muted uppercase tracking-wide">{m.label_division()}</span>
                  <span className="text-xs text-app-text truncate">{s.division}</span>
                </div>
              )}
            </CardContent>
            {s.imageUrl && (
              <img
                src={s.imageUrl}
                alt={carData.name}
                className="w-full object-contain bg-app-bg"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
            )}
          </Card>
        );
      })()}
    </div>
  );
}
