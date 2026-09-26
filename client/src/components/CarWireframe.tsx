import { tryGetGame } from "@shared/games/registry";
import { resolveAnalysisTelemetry } from "@shared/racing/analysis/telemetry-capabilities";
import { flipBoundaries, needsTrackFlip } from "@shared/racing/tracks/coords";
import { ChevronDownIcon } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { m } from "@/paraglide/messages";
import type { GameId } from "../../../shared/games/ids";
import type { TrackMapBoundaries } from "./analyse/track-map/types";
import { type CarModelEnrichment, DEMO_CAR, F1_CAR, getCarModel, getLMUClassCarModel, loadCarModelConfigs } from "../data/car-models";
import { useTirePressureOptimal } from "../hooks/catalog-queries";
import { useSettings } from "../hooks/settings";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useUnits } from "../hooks/useUnits";
import { client } from "../lib/rpc";
import { DEFAULT_TOGGLES, VIEW_PRESETS, type ViewPreset, type ViewToggles } from "../lib/wireframe-data";
import { useGameId } from "../stores/game";
import type { SemanticAnalysisFrame } from "./analyse/track-map/types";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";
import { DropdownMenu } from "./ui/DropdownMenu";
import { preloadCarModel } from "./wireframe/CarBody";
import { SceneRuntime, type SceneSource } from "./wireframe/SceneRuntime";
import { ToggleButton } from "./wireframe/ToggleButton";

preloadCarModel("/models/aston_martin_vantage_gt3_optimised.glb");
preloadCarModel("/models/f1_2025_mclaren_mcl39_optimised.glb");
preloadCarModel("/models/peugeot_9x8_evo_2024_optimised.glb");

export const CarWireframe = React.memo(function CarWireframe({
  gameId: gameIdProp,
  frame,
  telemetry,
  cursorIdx,
  outline,
  boundaries,
  carOrdinal,
  lmuCarClass,
  carModel: carModelProp,
  tempLabel: tempLabelProp,
  showDimensions,
  minimal,
  hideControls,
  autoOrbit,
  source,
  onRuntime,
}: {
  gameId?: GameId;
  lmuCarClass?: string;
  frame: SemanticAnalysisFrame;
  telemetry: SemanticAnalysisFrame[];
  cursorIdx: number;
  outline: { x: number; z: number }[] | null;
  boundaries?: Pick<TrackMapBoundaries, "leftEdge" | "rightEdge" | "raceLine"> | null;
  carOrdinal?: number;
  carModel?: CarModelEnrichment & { hasModel: boolean };
  tempLabel?: string;
  source: SceneSource;
  onRuntime?: (runtime: SceneRuntime | null) => void;
  showDimensions?: boolean;
  minimal?: boolean;
  hideControls?: boolean;
  autoOrbit?: boolean;
  onModelOffset?: (offset: { x: number; y: number; z: number }) => void;
}) {
  const [configsLoaded, setConfigsLoaded] = useState(false);
  useEffect(() => {
    loadCarModelConfigs().then(() => setConfigsLoaded(true));
  }, []);
  const storeGameId = useGameId();
  const gameId = gameIdProp ?? storeGameId;
  if (!gameId) {
    throw new Error("CarWireframe: gameId missing — pass as prop or mount inside a GameProvider");
  }
  const isF1 = gameId === "f1-2025";
  const isLMU = gameId === "lmu";

  const carModel = useMemo(() => {
    if (carModelProp) return carModelProp;
    if (isF1) return F1_CAR;
    // Select the closest available body for every catalog class.
    if (isLMU) return getLMUClassCarModel(lmuCarClass);
    // Note: getCarModel reads from module-level state populated by
    // loadCarModelConfigs(). configsLoaded is in the dep list so the
    // memo re-runs once configs finish loading — eslint can't see the
    // dependency because it's hidden behind an impure read.
    const perCar = getCarModel(carOrdinal ?? 0);
    if (perCar.hasModel) return perCar;
    // Fallback: any non-F1 game with no per-car GLB uses the Aston
    // Martin GT3 demo model. Previously this was FM-only, which left
    // ACC (and any future game) without a visible car in the scene.
    return DEMO_CAR;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carOrdinal, configsLoaded, isF1, isLMU, lmuCarClass, carModelProp]);
  const units = useUnits(gameId);
  const { displaySettings } = useSettings();
  const pressureOptimal = useTirePressureOptimal(gameId, carOrdinal);
  const adapter = tryGetGame(gameId);
  const suspThresholds = adapter?.suspensionThresholds.values ?? [25, 65, 85];
  const temperatureMetric = resolveAnalysisTelemetry(adapter).tireTemperature;
  const temperatureSemanticId = temperatureMetric.source !== "unavailable" && temperatureMetric.binding?.kind === "value"
    ? temperatureMetric.binding.semanticId
    : "tire.temperature.surface.representative";
  const tLabel = tempLabelProp ?? units.tempLabel;
  const fmtTemp = useCallback((v: number) => `${units.temp(v).toFixed(0)}${tLabel}`, [units, tLabel]);
  const [editMode, setEditMode] = useState(false);
  const [modelOffsetX, setModelOffsetX] = useState(carModel.glbOffsetX ?? 0);
  const [saveStatus, setSaveStatus] = useState<"" | "saving" | "saved">("");
  const [storedToggles, setToggles] = useLocalStorage<ViewToggles>("carwireframe-toggles", {
    ...DEFAULT_TOGGLES,
    dimensions: showDimensions ?? false,
  });
  // Merge defaults so any keys added after the user's localStorage was first
  // written get sensible values instead of undefined.
  const toggles = useMemo<ViewToggles>(() => ({
    ...DEFAULT_TOGGLES,
    ...storedToggles,
    ...(hideControls ? { inputs: true } : {}),
  }), [storedToggles, hideControls]);
  const [viewPreset, setViewPreset] = useState<ViewPreset>("3/4");

  const flippedBoundaries = useMemo(() => {
    if (!boundaries) return null;
    return needsTrackFlip(gameId) ? flipBoundaries(boundaries) : boundaries;
  }, [boundaries, gameId]);
  const viewToggleItems = [
    { key: "springs" as const, label: m.carwire_springs(), available: true },
    { key: "trails" as const, label: m.carwire_trails(), available: true },
    { key: "inputs" as const, label: m.carwire_inputs(), available: true },
    { key: "track" as const, label: m.carwire_track(), available: true },
    { key: "racingLine" as const, label: m.overlay_racing_line(), available: Array.isArray(flippedBoundaries?.raceLine) && flippedBoundaries.raceLine.length > 1 },
    { key: "grid" as const, label: m.carwire_grid(), available: true },
    { key: "drivetrain" as const, label: m.carwire_drive(), available: true },
    { key: "wheelInfo" as const, label: m.carwire_tire_info(), available: true },
  ]
    .filter((item) => item.available)
    .map((item) => ({
      type: "checkbox" as const,
      key: item.key,
      label: item.label,
      checked: toggles[item.key],
      onCheckedChange: (checked: boolean) => setToggles((previous) => ({ ...previous, [item.key]: checked })),
    }));
  const anyViewToggle = viewToggleItems.some((item) => item.checked);

  const fpsRef = useRef<HTMLSpanElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  useEffect(() => {
    if (!canvasHostRef.current) return;
    const runtime = new SceneRuntime(canvasHostRef.current, (error) => setRenderError(error.message), { fpsElement: fpsRef.current });
    runtimeRef.current = runtime;
    onRuntime?.(runtime);
    void runtime.init();
    return () => {
      runtimeRef.current = null;
      onRuntime?.(null);
      runtime.dispose();
    };
  }, [onRuntime]);
  useEffect(() => {
    runtimeRef.current?.setSource(source);
  }, [source]);
  useEffect(() => {
    runtimeRef.current?.updateConfig({
      gameId, frame, telemetry, cursorIdx, outline, boundaries: flippedBoundaries,
      toggles, viewPreset, carModel, modelOffsetX, hideModelWheels: !minimal,
      autoOrbit: !!autoOrbit, fpsCap: displaySettings.renderFpsCap,
      fmtTemp, suspThresholds, pressureOptimal, temperatureThresholds: units.thresholds, temperatureSemanticId,
    });
  }, [gameId, frame, telemetry, cursorIdx, outline, flippedBoundaries, toggles, viewPreset, carModel, modelOffsetX, minimal, autoOrbit, displaySettings.renderFpsCap, fmtTemp, suspThresholds, pressureOptimal, units.thresholds, temperatureSemanticId]);

  return (
    <div className="w-full h-full relative flex-1">
      <div ref={canvasHostRef} className="w-full h-full" role="img" aria-label={`3D tire temperatures ${["FL", "FR", "RL", "RR"].map((wheel, index) => {
        const value = (frame.values[temperatureSemanticId] as number[] | undefined)?.[index];
        return `${wheel} ${value != null && Number.isFinite(value) ? fmtTemp(value) : m.analyse_unavailable()}`;
      }).join(", ")}`} />
      {renderError && <div role="alert" className="absolute inset-0 flex items-center justify-center bg-app-bg text-status-danger p-4">{renderError}</div>}
      <span ref={fpsRef} data-visual-test-hidden className="absolute bottom-1 right-24 text-sm font-mono text-app-text-dim/50 px-1 py-0.5" />

      {/* View toggles */}
      {!hideControls && (
        <div className="absolute top-2 left-2 flex max-w-[65%] flex-wrap gap-1">
          <ToggleButton
            label={toggles.solid === "solid" ? m.carwire_solid() : toggles.solid === "hidden" ? m.carwire_hidden() : m.carwire_wire()}
            active={toggles.solid !== "wire"}
            onClick={() =>
              setToggles((prev) => ({
                ...prev,
                solid: prev.solid === "wire" ? "solid" : prev.solid === "solid" ? "hidden" : "wire",
              }))
            }
          />
          {!minimal && (
            <DropdownMenu
              align="left"
              trigger={
                <Button
                  className={`px-2 py-1 text-app-micro uppercase tracking-wider font-semibold rounded border transition-colors ${
                    anyViewToggle ? "bg-app-accent/15 border-app-accent/40 text-app-accent" : "bg-app-surface-alt/80 border-app-border-input text-app-text-muted hover:text-app-text"
                  }`}
                >
                  {m.carwire_view()}
                  <ChevronDownIcon data-icon="inline-end" />
                </Button>
              }
              items={viewToggleItems}
            />
          )}
          {minimal && (
            <div className="flex items-center gap-2 rounded border border-app-border-input bg-app-surface-alt/80 px-2 py-1">
              <Switch size="sm" checked={toggles.dimensions} aria-label={m.carwire_dims()} onCheckedChange={(checked) => setToggles((previous) => ({ ...previous, dimensions: checked }))} />
              <span className="text-app-micro font-semibold uppercase tracking-wider text-app-text-muted">{m.carwire_dims()}</span>
            </div>
          )}
        </div>
      )}

      {/* Camera presets + steering indicator */}
      {!hideControls && (
        <div className="absolute top-2 right-2 flex flex-col gap-2 items-end">
          <div className="flex flex-col gap-1">
            {(Object.keys(VIEW_PRESETS) as ViewPreset[]).map((key) => (
              <ToggleButton key={key} label={key} active={viewPreset === key} onClick={() => setViewPreset(key)} />
            ))}
          </div>
        </div>
      )}

      {/* Model edit controls (minimal/car viewer mode) */}
      {!hideControls && minimal && !editMode && carModel.hasModel && (
        <Button
          onClick={() => setEditMode(true)}
          className="absolute bottom-2 left-2 px-2 py-1 text-app-caption rounded bg-app-surface-alt/80 border border-app-border-input text-app-text-muted hover:text-app-text transition-colors"
        >
          {m.label_edit_model()}
        </Button>
      )}
      {!hideControls && minimal && editMode && (
        <div className="absolute bottom-2 left-2 bg-app-bg/90 rounded-lg border border-app-border p-2 text-app-caption font-mono space-y-1.5" style={{ minWidth: 220 }}>
          <div className="flex items-center justify-between">
            <span className="text-app-text-muted uppercase tracking-wider">{m.label_model_offset()}</span>
            <div className="flex gap-1">
              <Button
                onClick={async () => {
                  setSaveStatus("saving");
                  try {
                    const res = await client.api["car-model-configs"][":ordinal"].$put({
                      param: { ordinal: encodeURIComponent(String(carOrdinal)) },
                      json: { glbOffsetX: modelOffsetX },
                    });
                    if (res.ok) {
                      setSaveStatus("saved");
                      setTimeout(() => {
                        setSaveStatus("");
                        setEditMode(false);
                      }, 1000);
                    } else {
                      setSaveStatus("");
                    }
                  } catch {
                    setSaveStatus("");
                  }
                }}
                className={`px-1.5 py-0.5 rounded border transition-colors ${
                  saveStatus === "saved" ? "bg-status-success text-app-on-filled border-status-success" : "bg-status-success/80 hover:bg-status-success text-app-on-filled border-status-success/30"
                }`}
              >
                {saveStatus === "saving" ? "..." : saveStatus === "saved" ? m.carwire_saved() : "Save"}
              </Button>
              <Button
                onClick={() => {
                  setEditMode(false);
                  setModelOffsetX(carModel.glbOffsetX ?? 0);
                }}
                className="px-1.5 py-0.5 rounded bg-app-surface-alt border border-app-border-input text-app-text-muted hover:text-app-text transition-colors"
              >
                {m.label_cancel()}
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-app-text-muted w-8">X</span>
            <input type="range" min={-0.5} max={0.5} step={0.01} value={modelOffsetX} onChange={(e) => setModelOffsetX(parseFloat(e.target.value))} className="flex-1 accent-app-accent" />
            <span className="text-app-text w-14 text-right">{(modelOffsetX * 1000).toFixed(0)}mm</span>
          </div>
        </div>
      )}

      {/* Input bars removed — shown on 2D track map panel + 3D input overlay */}
    </div>
  );
});
