import { getSchemaForGame, readSetupSection } from "@shared/racing/setups/schema";
import { useEffect, useMemo, useState } from "react";
import { AcEvoSetupContent } from "./AcEvoSetupContent";
import { AppInput } from "@/components/ui/AppInput";
import { SearchSelect } from "../ui/SearchSelect";
import { useTracksForGame } from "../../hooks/catalog-queries";
import { m } from "@/paraglide/messages";
import type { GameId } from "../../../../shared/games/ids";
import { Button } from "../ui/button";
import { FillForm } from "./FillForm";
export interface SetupTuneData {
  gameId: GameId;
  name: string;
  author: string;
  carOrdinal: number;
  trackOrdinal: number | null;
  category: string;
  description: string;
  settings: Record<string, unknown>;
}

export interface CategoryOption {
  value: string;
  label: string;
}

// The four in-game ACC setup types plus a wet flag. Matches the four session
// categories Kunos exposes in the setup menu.
export const ACC_CATEGORIES: CategoryOption[] = [
  { value: "qualifying", label: m.setup_tune_category_qualifying() },
  { value: "race", label: m.setup_tune_category_race() },
  { value: "safe", label: m.setup_tune_category_safe() },
  { value: "wet", label: m.setup_tune_category_wet() },
];

// AC EVO covers road and track driving, so the categories include a broader
// mix than ACC's four in-game types.
export const AC_EVO_CATEGORIES: CategoryOption[] = [
  { value: "qualifying", label: m.setup_tune_category_qualifying() },
  { value: "race", label: m.setup_tune_category_race() },
  { value: "endurance", label: m.setup_tune_category_endurance() },
  { value: "safe", label: m.setup_tune_category_safe_baseline() },
  { value: "wet", label: m.setup_tune_category_wet() },
  { value: "trackday", label: m.setup_tune_category_track_day() },
  { value: "road", label: m.setup_tune_category_road() },
];

export function getCategoriesForGame(gameId: GameId): CategoryOption[] {
  if (gameId === "acc") return ACC_CATEGORIES;
  if (gameId === "ac-evo") return AC_EVO_CATEGORIES;
  return [{ value: "circuit", label: m.setup_tune_category_circuit() }];
}

/** Structured ACC / AC Evo setup editor. */
export function SetupTuneForm({
  gameId,
  cars,
  initialData,
  onSubmit,
  onCancel,
  title,
  isSubmitting,
}: {
  gameId: GameId;
  cars: { ordinal: number; name: string }[];
  initialData?: Partial<SetupTuneData>;
  onSubmit: (data: SetupTuneData) => void;
  onCancel: () => void;
  title: string;
  isSubmitting: boolean;
}) {
  const { data: tracks = [] } = useTracksForGame(gameId);
  const [trackOrdinal, setTrackOrdinal] = useState<number | null>(initialData?.trackOrdinal ?? null);
  const categories = getCategoriesForGame(gameId);
  const schema = useMemo(() => getSchemaForGame(gameId), [gameId]);
  const defaultCategory = categories[0]?.value ?? "race";

  const [name, setName] = useState(initialData?.name ?? "");
  const [author, setAuthor] = useState(initialData?.author ?? m.setup_tune_default_author());
  const [carOrdinal, setCarOrdinal] = useState<number>(initialData?.carOrdinal ?? cars[0]?.ordinal ?? 0);
  const [category, setCategory] = useState(initialData?.category ?? defaultCategory);
  const [description, setDescription] = useState(initialData?.description ?? "");
  // Structured-form state: keep a live settings object the fill-form mutates.
  const [settings, setSettings] = useState<Record<string, unknown>>(() => initialData?.settings ?? {});

  useEffect(() => {
    if (!initialData) return;
    setName(initialData.name ?? "");
    setAuthor(initialData.author ?? m.setup_tune_default_author());
    setCarOrdinal(initialData.carOrdinal ?? cars[0]?.ordinal ?? 0);
    setCategory(initialData.category ?? defaultCategory);
    setDescription(initialData.description ?? "");
    setTrackOrdinal(initialData.trackOrdinal ?? null);
    const next = initialData.settings ?? {};
    setSettings(next);
  }, [initialData, cars, defaultCategory]);


  const coveredSections = useMemo(
    () => gameId === "ac-evo" ? 0 : schema.reduce((count, section) => count + (readSetupSection(settings, section) ? 1 : 0), 0),
    [gameId, settings, schema],
  );

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    onSubmit({ gameId, name, author, carOrdinal, trackOrdinal, category, description, settings });
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col min-h-full">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-app-border bg-app-bg py-3 pr-4">
        <Button variant="app-ghost" size="app-sm" onClick={onCancel}>
          &larr;
        </Button>
        <h2 className="min-w-0 flex-1 text-base font-semibold text-app-text">{title}</h2>
        <div className="flex items-center gap-2 ml-auto">
          <Button variant="app-outline" size="app-sm" onClick={onCancel}>
            {m.common_cancel()}
          </Button>
          <Button type="submit" variant="app-primary" size="app-sm" disabled={!name || isSubmitting}>
            {isSubmitting ? m.common_saving() : m.setupform_save_setup()}
          </Button>
        </div>
      </div>

      <div className="grid w-full grid-cols-1 gap-4 p-4 sm:grid-cols-2">

        <label className="min-w-0 space-y-2">
          <span className="text-xs font-medium text-app-text-muted">{m.tune_form_name()}</span>
          <AppInput type="text" value={name} onChange={(e) => setName(e.target.value)} required className="h-8 w-full py-1" />
        </label>

        <label className="min-w-0 space-y-2">
          <span className="text-xs font-medium text-app-text-muted">{m.label_author()}</span>
          <AppInput type="text" value={author} onChange={(e) => setAuthor(e.target.value)} required className="h-8 w-full py-1" />
        </label>

        <label className="min-w-0 space-y-2">
          <span className="text-xs font-medium text-app-text-muted">{m.label_car()}</span>
          <SearchSelect
            value={String(carOrdinal)}
            onChange={(value) => setCarOrdinal(Number(value))}
            options={cars.map((car) => ({ value: String(car.ordinal), label: car.name }))}
            ariaLabel={m.label_car()}
            placeholder={m.analyse_search_cars()}
            className="h-8 w-full min-w-0 text-sm"
          />
        </label>

        <label className="min-w-0 space-y-2">
          <span className="text-xs font-medium text-app-text-muted">{m.label_track()}</span>
          <SearchSelect
            value={trackOrdinal == null ? "" : String(trackOrdinal)}
            onChange={(value) => setTrackOrdinal(value ? Number(value) : null)}
            options={[
              { value: "", label: m.setup_any_track() },
              ...tracks.map((track) => ({ value: String(track.ordinal), label: track.name })),
            ]}
            fallbackLabel={trackOrdinal != null && !tracks.some((track) => track.ordinal === trackOrdinal) ? `Track ${trackOrdinal}` : undefined}
            ariaLabel={m.label_track()}
            placeholder={m.analyse_search_tracks()}
            className="h-8 w-full min-w-0 text-sm"
          />
        </label>

        <label className="min-w-0 space-y-2">
          <span className="text-xs font-medium text-app-text-muted">{m.label_category()}</span>
          <SearchSelect
            value={category}
            onChange={setCategory}
            options={categories}
            ariaLabel={m.label_category()}
            placeholder={m.label_category()}
            className="h-8 w-full min-w-0 text-sm"
          />
        </label>

        <label className="space-y-2 sm:col-span-2">
          <span className="text-xs font-medium text-app-text-muted">{m.tune_form_description()}</span>
          <AppInput type="text" value={description} onChange={(e) => setDescription(e.target.value)} className="h-8 w-full py-1" />
        </label>

        {gameId !== "ac-evo" && schema.length > 0 && (
          <div className="flex items-center justify-between sm:col-span-2">
            <span className="text-xs font-medium text-app-text-muted">{m.setupform_tunable_sections()}</span>
            <span className="text-app-caption text-app-text-muted">
              {coveredSections} / {schema.length} {m.setupform_covered()}
            </span>
          </div>
        )}

        {gameId === "ac-evo" ? (
          <div className="min-w-0 border-t border-app-border pt-5 sm:col-span-2">
            <AcEvoSetupContent settings={settings} onChange={(knob, value) => setSettings((previous) => {
              const next = { ...previous };
              if (value === undefined) delete next[knob];
              else next[knob] = value;
              return next;
            })} />
          </div>
        ) : schema.length > 0 && <FillForm sections={schema} settings={settings} onChange={setSettings} />}

      </div>
    </form>
  );
}
