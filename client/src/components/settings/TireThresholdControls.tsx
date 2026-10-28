import { useEffect, useMemo, useState } from "react";
import type { GameId } from "@raceiq/shared/games/ids";
import { getAllGames } from "@raceiq/shared/games/registry";
import { getTireCompoundOptions, getTireThresholds } from "@raceiq/shared/racing/live/tire-thresholds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSaveSettings, useSettings } from "@/hooks/settings";
import { m } from "@/paraglide/messages";
import type { TireThresholds } from "@raceiq/shared/racing/live/tire-thresholds";

type Draft = { cliffPct: string; deadPct: string };

export function TireThresholdControls() {
  const games = getAllGames();
  const [gameId, setGameId] = useState<GameId>(games[0]!.id);
  const { displaySettings, settingsLoaded } = useSettings();
  const saveSettings = useSaveSettings();
  const overrides = displaySettings.tireThresholdOverrides ?? {};
  const options = getTireCompoundOptions(gameId);
  const [compound, setCompound] = useState("default");
  const [customCompound, setCustomCompound] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);
  const compoundOptions = useMemo(() => [...new Set([...options, ...Object.keys(overrides[gameId] ?? {}), compound])], [options, overrides, gameId, compound]);
  const savedOverride = overrides[gameId]?.[compound];
  const effective = getTireThresholds(overrides, gameId, compound);

  useEffect(() => {
    setDraft({ cliffPct: String(effective.cliffPct), deadPct: String(effective.deadPct) });
    setError(false);
  }, [gameId, compound, effective.cliffPct, effective.deadPct]);
  useEffect(() => { setSaved(false); }, [gameId, compound]);

  const locked = !settingsLoaded || saveSettings.isPending;
  const cliff = draft?.cliffPct === "" ? Number.NaN : Number(draft?.cliffPct);
  const dead = draft?.deadPct === "" ? Number.NaN : Number(draft?.deadPct);
  const invalid = !Number.isFinite(cliff) || !Number.isFinite(dead) || cliff < 0 || dead < 0 || cliff > 100 || dead > 100 || dead >= cliff;
  const changed = !savedOverride || cliff !== savedOverride.cliffPct || dead !== savedOverride.deadPct;

  async function save() {
    if (invalid || !draft) return;
    const next: TireThresholds = { cliffPct: cliff, deadPct: dead };
    const nextOverrides = { ...overrides, [gameId]: { ...overrides[gameId], [compound]: next } };
    setError(false);
    setSaved(false);
    try {
      await saveSettings.mutateAsync({ tireThresholdOverrides: nextOverrides });
      setSaved(true);
    } catch {
      setError(true);
    }
  }

  async function reset() {
    const gameOverrides = { ...overrides[gameId] };
    delete gameOverrides[compound];
    const nextOverrides = { ...overrides };
    if (Object.keys(gameOverrides).length) nextOverrides[gameId] = gameOverrides;
    else delete nextOverrides[gameId];
    setError(false);
    setSaved(false);
    try {
      await saveSettings.mutateAsync({ tireThresholdOverrides: nextOverrides });
    } catch {
      setError(true);
    }
  }

  function addCustomCompound() {
    const value = customCompound.trim().toLowerCase();
    if (!value) return;
    setCompound(value);
    setCustomCompound("");
  }

  return (
    <div className="mt-4 max-w-xl space-y-3 rounded border border-app-border-input bg-app-surface p-3">
      <h3 className="text-sm font-semibold text-app-text">{m.threshold_settings_title()}</h3>
      <div>
        <Label htmlFor="tire-threshold-game" className="text-app-text-secondary">{m.threshold_game_label()}</Label>
        <select id="tire-threshold-game" aria-label={m.threshold_game_label()} value={gameId} disabled={locked} onChange={(event) => { setGameId(event.target.value as GameId); setCompound("default"); }} className="mt-1.5 h-9 w-full rounded-md border border-app-border-input bg-app-surface px-3 text-sm text-app-text">
          {games.map((game) => <option key={game.id} value={game.id}>{game.displayName}</option>)}
        </select>
      </div>
      <div>
        <Label htmlFor={`tire-compound-${gameId}`} className="text-app-text-secondary">{m.threshold_compound_label()}</Label>
        <select id={`tire-compound-${gameId}`} aria-label={m.threshold_compound_label()} value={compound} disabled={locked} onChange={(event) => setCompound(event.target.value)} className="mt-1.5 h-9 w-full rounded-md border border-app-border-input bg-app-surface px-3 text-sm text-app-text">
          {compoundOptions.map((option) => <option key={option} value={option}>{option === "default" ? m.threshold_default_compound() : option}</option>)}
        </select>
        <div className="mt-2 flex gap-2">
          <Input aria-label={m.threshold_custom_compound_label()} placeholder={m.threshold_custom_compound_placeholder()} value={customCompound} disabled={locked} onChange={(event) => setCustomCompound(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addCustomCompound(); } }} />
          <Button type="button" variant="app-outline" size="app-sm" disabled={locked || !customCompound.trim()} onClick={addCustomCompound}>{m.threshold_add_compound()}</Button>
        </div>
      </div>
      <p className="text-xs text-app-text-muted">{m.threshold_effective_values({ cliff: effective.cliffPct, dead: effective.deadPct })}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor={`tire-cliff-${gameId}`} className="text-app-text-secondary">{m.threshold_cliff_label()}</Label>
          <Input id={`tire-cliff-${gameId}`} aria-label={m.threshold_cliff_label()} type="number" min="0" max="100" value={draft?.cliffPct ?? ""} disabled={locked} onChange={(event) => { setDraft((current) => ({ cliffPct: event.target.value, deadPct: current?.deadPct ?? "" })); setError(false); setSaved(false); }} />
        </div>
        <div>
          <Label htmlFor={`tire-dead-${gameId}`} className="text-app-text-secondary">{m.threshold_dead_label()}</Label>
          <Input id={`tire-dead-${gameId}`} aria-label={m.threshold_dead_label()} type="number" min="0" max="100" value={draft?.deadPct ?? ""} disabled={locked} onChange={(event) => { setDraft((current) => ({ cliffPct: current?.cliffPct ?? "", deadPct: event.target.value })); setError(false); setSaved(false); }} />
        </div>
      </div>
      {invalid && <p role="alert" className="text-xs text-status-danger">{m.threshold_validation_error()}</p>}
      {error && <p role="alert" className="text-xs text-status-danger">{m.threshold_save_failed()}</p>}
      {saved && <p role="status" className="text-xs text-app-text-muted">{m.threshold_saved()}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="app-outline" size="app-sm" disabled={locked || !savedOverride} onClick={() => void reset()}>{m.threshold_reset()}</Button>
        <Button type="button" variant="app-primary" size="app-sm" disabled={locked || invalid || !changed} onClick={() => void save()}>{saveSettings.isPending ? m.common_saving() : m.common_save()}</Button>
      </div>
    </div>
  );
}
