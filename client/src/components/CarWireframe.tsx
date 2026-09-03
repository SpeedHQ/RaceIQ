import { useGLTF } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { tryGetGame } from "@shared/games/registry";
import { flipBoundaries, needsTrackFlip } from "@shared/racing/tracks/coords";
import { ChevronDownIcon } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { m } from "@/paraglide/messages";
import type { GameId } from "../../../shared/games/ids";
import type { TrackMapBoundaries } from "./analyse/track-map/types";
import { type CarModelEnrichment, DEMO_CAR, F1_CAR, getCarModel, loadCarModelConfigs } from "../data/car-models";
import { useSettings } from "../hooks/settings";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useUnits } from "../hooks/useUnits";
import { recordGpuSnapshot } from "../lib/crash-diagnostics";
import { client } from "../lib/rpc";
import { tireTempColor } from "../lib/vehicle-dynamics";
import { DEFAULT_TOGGLES, VIEW_PRESETS, type ViewPreset, type ViewToggles } from "../lib/wireframe-data";
import { useGameId } from "../stores/game";
import type { SemanticAnalysisFrame } from "./analyse/track-map/types";
import { Button } from "./ui/button";
import { DropdownMenu } from "./ui/DropdownMenu";
import { CarScene } from "./wireframe/CarScene";
import { ToggleButton } from "./wireframe/ToggleButton";

useGLTF.preload("/models/aston_martin_vantage_gt3_optimised.glb");
useGLTF.preload("/models/f1_2025_mclaren_mcl39_optimised.glb");

export const CarWireframe = React.memo(function CarWireframe({
  gameId: gameIdProp,
  frame,
  telemetry,
  cursorIdx,
  outline,
  boundaries,
  carOrdinal,
  carModel: carModelProp,
  tempLabel: tempLabelProp,
  showDimensions,
  minimal,
  hideControls,
  autoOrbit,
}: {
  gameId?: GameId;
  frame: SemanticAnalysisFrame;
  telemetry: SemanticAnalysisFrame[];
  cursorIdx: number;
  outline: { x: number; z: number }[] | null;
  boundaries?: Pick<TrackMapBoundaries, "leftEdge" | "rightEdge" | "raceLine"> | null;
  carOrdinal?: number;
  carModel?: CarModelEnrichment & { hasModel: boolean };
  tempLabel?: string;
  cursorRef?: React.RefObject<number>;
  telemetryRef?: React.RefObject<SemanticAnalysisFrame[]>;
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

  const carModel = useMemo(() => {
    if (carModelProp) return carModelProp;
    if (isF1) return F1_CAR;
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
  }, [carOrdinal, configsLoaded, isF1, carModelProp]);
  const units = useUnits(gameId);
  const { displaySettings } = useSettings();
  const suspThresholds = tryGetGame(gameId)?.suspensionThresholds.values ?? [25, 65, 85];
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
  // When controls are hidden (e.g. onboarding preview) force wheelInfo off —
  // the user has no way to toggle it and the stat cards clutter the scene.
  const toggles: ViewToggles = {
    ...DEFAULT_TOGGLES,
    ...storedToggles,
    ...(hideControls ? { wheelInfo: false, inputs: true } : {}),
  };
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
  const fpsFrames = useRef(0);
  const [fpsInitTime] = useState(() => performance.now());
  const fpsLastTime = useRef(fpsInitTime);

  // Keep current cap in a ref so the render gate picks up settings changes
  // without re-creating the Canvas.
  const fpsCapRef = useRef(displaySettings.renderFpsCap);
  useEffect(() => {
    fpsCapRef.current = displaySettings.renderFpsCap;
  }, [displaySettings.renderFpsCap]);

  return (
    <div className="w-full h-full relative flex-1">
      <Canvas
        key="raceiq-car-renderer-v2"
        camera={{ position: [4, 2.5, 4], fov: 50 }}
        gl={{ antialias: false, alpha: true, powerPreference: "high-performance", preserveDrawingBuffer: !!(window as unknown as Record<string, unknown>).__recording }}
        dpr={[1, 1.5]}
        frameloop="always"
        tabIndex={-1}
        style={{ background: "transparent", outline: "none", WebkitTapHighlightColor: "transparent", userSelect: "none" }}
        onCreated={({ gl }) => {
          type RenderGate = {
            originalRender: typeof gl.render;
            capRef: typeof fpsCapRef;
            fpsElementRef: typeof fpsRef;
            fpsFramesRef: typeof fpsFrames;
            fpsLastTimeRef: typeof fpsLastTime;
            nextRenderAt: number;
            activeCap: number;
            lastGpuLog: number;
          };
          const renderer = gl as typeof gl & { __raceIqRenderGate?: RenderGate };
          const existingGate = renderer.__raceIqRenderGate;
          if (existingGate) {
            existingGate.capRef = fpsCapRef;
            existingGate.fpsElementRef = fpsRef;
            existingGate.fpsFramesRef = fpsFrames;
            existingGate.fpsLastTimeRef = fpsLastTime;
            return;
          }

          const gate: RenderGate = {
            originalRender: gl.render.bind(gl),
            capRef: fpsCapRef,
            fpsElementRef: fpsRef,
            fpsFramesRef: fpsFrames,
            fpsLastTimeRef: fpsLastTime,
            nextRenderAt: 0,
            activeCap: 0,
            lastGpuLog: 0,
          };
          renderer.__raceIqRenderGate = gate;
          gl.render = (...args: Parameters<typeof gl.render>) => {
            // Gate gl.render to the user's fps cap. Deadline scheduling
            // alternates refresh ticks when the display rate is not a clean
            // multiple of the cap instead of consistently landing below it.
            const now = performance.now();
            const recording = !!(window as unknown as Record<string, unknown>).__recording;
            const cap = Math.max(15, Math.min(120, gate.capRef.current));
            if (recording) {
              gate.nextRenderAt = 0;
            } else {
              if (cap !== gate.activeCap) {
                gate.activeCap = cap;
                gate.nextRenderAt = now;
              }
              if (now + 1 < gate.nextRenderAt) return;
              const interval = 1000 / cap;
              gate.nextRenderAt += interval;
              if (gate.nextRenderAt <= now) gate.nextRenderAt = now + interval;
            }

            gate.fpsFramesRef.current++;
            if (now - gate.fpsLastTimeRef.current >= 1000) {
              const elapsed = now - gate.fpsLastTimeRef.current;
              const measuredFps = Math.round((gate.fpsFramesRef.current * 1000) / elapsed);
              if (gate.fpsElementRef.current) gate.fpsElementRef.current.textContent = `${measuredFps} fps`;
              gate.fpsFramesRef.current = 0;
              gate.fpsLastTimeRef.current = now;
            }

            // Feed Three.js renderer counters into the crash-diagnostics
            // breadcrumb once per second. gl.info.render is reset every
            // frame by Three.js, so sample inside the render function.
            if (now - gate.lastGpuLog >= 1000) {
              gate.lastGpuLog = now;
              recordGpuSnapshot({
                memory: gl.info.memory,
                programs: gl.info.programs,
                render: gl.info.render,
              });
            }

            return gate.originalRender(...args);
          };
        }}
      >
        <CarScene
          gameId={gameId}
          frame={frame}
          telemetry={telemetry}
          cursorIdx={cursorIdx}
          outline={outline}
          boundaries={flippedBoundaries}
          toggles={toggles}
          viewPreset={viewPreset}
          carModel={carModel}
          modelOffsetX={modelOffsetX}
          fmtTemp={fmtTemp}
          hideModelWheels={!minimal}
          suspThresholds={suspThresholds}
          autoOrbit={autoOrbit}
          tireColors={[
            tireTempColor(units.toTempC((frame.values["tire.temperature.average"] as number[] | undefined)?.[0] ?? 0), units.thresholds),
            tireTempColor(units.toTempC((frame.values["tire.temperature.average"] as number[] | undefined)?.[1] ?? 0), units.thresholds),
            tireTempColor(units.toTempC((frame.values["tire.temperature.average"] as number[] | undefined)?.[2] ?? 0), units.thresholds),
            tireTempColor(units.toTempC((frame.values["tire.temperature.average"] as number[] | undefined)?.[3] ?? 0), units.thresholds),
          ]}
        />
      </Canvas>
      <span ref={fpsRef} className="absolute bottom-1 right-24 text-sm font-mono text-app-text-dim/50 px-1 py-0.5" />

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
          {minimal && <ToggleButton label={m.carwire_dims()} active={toggles.dimensions} onClick={() => setToggles((previous) => ({ ...previous, dimensions: !previous.dimensions }))} />}
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
                      param: { ordinal: String(carOrdinal) },
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
