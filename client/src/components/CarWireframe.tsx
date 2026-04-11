import React, { useRef, useMemo, useState, useCallback, useEffect } from "react";
import { client } from "../lib/rpc";
import { Canvas } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import type { TelemetryPacket } from "@shared/types";
import { getCarModel, loadCarModelConfigs, F1_CAR, DEMO_CAR, type CarModelEnrichment } from "../data/car-models";
import { tireTempColorHex } from "../lib/vehicle-dynamics";
import { useUnits } from "../hooks/useUnits";
import { useSettings } from "../hooks/queries";
import { useGameId } from "../stores/game";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { type ViewPreset, VIEW_PRESETS, type ViewToggles, DEFAULT_TOGGLES } from "../lib/wireframe-data";
import { CarScene } from "./wireframe/CarScene";
import { ToggleButton } from "./wireframe/ToggleButton";

// Re-export symbols used by other modules
export { DEFAULT_HIDDEN_MESHES, classifyMesh } from "./wireframe/CarBody";

useGLTF.preload("/models/aston_martin_vantage_gt3.glb");
useGLTF.preload("/models/f1_2025_mclaren_mcl39.glb");

export const CarWireframe = React.memo(function CarWireframe({
  packet,
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
  packet: TelemetryPacket;
  telemetry: TelemetryPacket[];
  cursorIdx: number;
  outline: { x: number; z: number }[] | null;
  boundaries?: { leftEdge: { x: number; z: number }[]; rightEdge: { x: number; z: number }[] } | null;
  carOrdinal?: number;
  carModel?: CarModelEnrichment & { hasModel: boolean };
  tempLabel?: string;
  cursorRef?: React.RefObject<number>;
  telemetryRef?: React.RefObject<TelemetryPacket[]>;
  showDimensions?: boolean;
  minimal?: boolean;
  hideControls?: boolean;
  autoOrbit?: boolean;
  onModelOffset?: (offset: { x: number; y: number; z: number }) => void;
}) {
  const [configsLoaded, setConfigsLoaded] = useState(false);
  useEffect(() => { loadCarModelConfigs().then(() => setConfigsLoaded(true)); }, []);
  const gameId = useGameId();
  const isF1 = gameId === "f1-2025";

  const isFM = gameId === "fm-2023";
  const carModel = useMemo(() => {
    if (carModelProp) return carModelProp;
    if (isF1) return F1_CAR;
    const perCar = getCarModel(carOrdinal ?? 0);
    if (perCar.hasModel) return perCar;
    if (isFM) return DEMO_CAR;
    return perCar;
  }, [carOrdinal, configsLoaded, isF1, isFM, carModelProp]);
  const units = useUnits();
  const { displaySettings } = useSettings();
  const suspThresholds = displaySettings.suspensionThresholds.values;
  const tLabel = tempLabelProp ?? units.tempLabel;
  const fmtTemp = useCallback((v: number) => `${units.temp(v).toFixed(0)}${tLabel}`, [units, tLabel]);
  const [editMode, setEditMode] = useState(false);
  const [modelOffsetX, setModelOffsetX] = useState(carModel.glbOffsetX ?? 0);
  const [saveStatus, setSaveStatus] = useState<"" | "saving" | "saved">("");
  const [toggles, setToggles] = useLocalStorage<ViewToggles>("carwireframe-toggles", {
    ...DEFAULT_TOGGLES,
    dimensions: showDimensions ?? false,
  });
  const [viewPreset, setViewPreset] = useState<ViewPreset>("3/4");

  const toggle = (key: keyof ViewToggles) =>
    setToggles((prev) => ({ ...prev, [key]: !prev[key] }));

  const fpsRef = useRef<HTMLSpanElement>(null);
  const fpsFrames = useRef(0);
  const [fpsInitTime] = useState(() => performance.now());
  const fpsLastTime = useRef(fpsInitTime);

  return (
    <div className="w-full h-full relative flex-1">
      <Canvas
        camera={{ position: [4, 2.5, 4], fov: 50 }}
        gl={{ antialias: false, alpha: true, powerPreference: "high-performance" }}
        dpr={[1, 1.5]}
        style={{ background: "transparent" }}
        onCreated={({ gl }) => {
          const origRender = gl.render.bind(gl);
          gl.render = (...args: Parameters<typeof gl.render>) => {
            fpsFrames.current++;
            const now = performance.now();
            if (now - fpsLastTime.current >= 1000) {
              if (fpsRef.current) fpsRef.current.textContent = `${fpsFrames.current} fps`;
              fpsFrames.current = 0;
              fpsLastTime.current = now;
            }
            return origRender(...args);
          };
        }}
      >
        <CarScene packet={packet} telemetry={telemetry} cursorIdx={cursorIdx} outline={outline} boundaries={boundaries ?? null} toggles={toggles} viewPreset={viewPreset} carModel={carModel} modelOffsetX={modelOffsetX} fmtTemp={fmtTemp} hideModelWheels={!minimal} suspThresholds={suspThresholds} autoOrbit={autoOrbit} tireColors={[
          tireTempColorHex(units.toTempC(packet.TireTempFL), units.thresholds),
          tireTempColorHex(units.toTempC(packet.TireTempFR), units.thresholds),
          tireTempColorHex(units.toTempC(packet.TireTempRL), units.thresholds),
          tireTempColorHex(units.toTempC(packet.TireTempRR), units.thresholds),
        ]} />
      </Canvas>
      <span ref={fpsRef} className="absolute bottom-1 right-24 text-sm font-mono text-app-text-dim/50 px-1 py-0.5" />

      {/* View toggles */}
      {!hideControls && <div className="absolute top-2 left-2 flex flex-wrap gap-1 max-w-[65%]">
        <ToggleButton
          label={toggles.solid === "solid" ? "Solid" : toggles.solid === "hidden" ? "Hidden" : "Wire"}
          active={toggles.solid !== "wire"}
          onClick={() => setToggles((prev) => ({
            ...prev,
            solid: prev.solid === "wire" ? "solid" : prev.solid === "solid" ? "hidden" : "wire",
          }))}
        />
        {!minimal && <ToggleButton label="Springs" active={toggles.springs} onClick={() => toggle("springs")} />}
        {!minimal && <ToggleButton label="Trails" active={toggles.trails} onClick={() => toggle("trails")} />}
        {!minimal && <ToggleButton label="Inputs" active={toggles.inputs} onClick={() => toggle("inputs")} />}
        {!minimal && <ToggleButton label="Track" active={toggles.track} onClick={() => toggle("track")} />}
        {!minimal && <ToggleButton label="Grid" active={toggles.grid} onClick={() => toggle("grid")} />}
        {!minimal && <ToggleButton label="Drive" active={toggles.drivetrain} onClick={() => toggle("drivetrain")} />}
        {minimal && <ToggleButton label="Dims" active={toggles.dimensions} onClick={() => toggle("dimensions")} />}
      </div>}

      {/* Camera presets + steering indicator */}
      {!hideControls && <div className="absolute top-2 right-2 flex flex-col gap-2 items-end">
        <div className="flex flex-col gap-1">
          {(Object.keys(VIEW_PRESETS) as ViewPreset[]).map((key) => (
            <ToggleButton key={key} label={key} active={viewPreset === key} onClick={() => setViewPreset(key)} />
          ))}
        </div>

      </div>}

      {/* Model edit controls (minimal/car viewer mode) */}
      {!hideControls && minimal && !editMode && carModel.hasModel && (
        <button
          onClick={() => setEditMode(true)}
          className="absolute bottom-2 left-2 px-2 py-1 text-[10px] rounded bg-app-surface-alt/80 border border-app-border-input text-app-text-muted hover:text-app-text transition-colors"
        >
          Edit Model
        </button>
      )}
      {!hideControls && minimal && editMode && (
        <div className="absolute bottom-2 left-2 bg-app-bg/90 rounded-lg border border-app-border p-2 text-[10px] font-mono space-y-1.5" style={{ minWidth: 220 }}>
          <div className="flex items-center justify-between">
            <span className="text-app-text-muted uppercase tracking-wider">Model Offset</span>
            <div className="flex gap-1">
              <button
                onClick={async () => {
                  setSaveStatus("saving");
                  try {
                    const res = await client.api["car-model-configs"][":ordinal"].$put({
                      param: { ordinal: String(carOrdinal) },
                      json: { glbOffsetX: modelOffsetX },
                    });
                    if (res.ok) {
                      setSaveStatus("saved");
                      setTimeout(() => { setSaveStatus(""); setEditMode(false); }, 1000);
                    } else {
                      setSaveStatus("");
                    }
                  } catch {
                    setSaveStatus("");
                  }
                }}
                className={`px-1.5 py-0.5 rounded border transition-colors ${
                  saveStatus === "saved"
                    ? "bg-green-600 text-white border-green-400"
                    : "bg-green-700/80 hover:bg-green-600 text-white border-green-500/30"
                }`}
              >
                {saveStatus === "saving" ? "..." : saveStatus === "saved" ? "Saved" : "Save"}
              </button>
              <button
                onClick={() => { setEditMode(false); setModelOffsetX(carModel.glbOffsetX ?? 0); }}
                className="px-1.5 py-0.5 rounded bg-app-surface-alt border border-app-border-input text-app-text-muted hover:text-app-text transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-app-text-muted w-8">X</span>
            <input
              type="range"
              min={-0.5}
              max={0.5}
              step={0.01}
              value={modelOffsetX}
              onChange={(e) => setModelOffsetX(parseFloat(e.target.value))}
              className="flex-1 accent-app-accent"
            />
            <span className="text-app-text w-14 text-right">{(modelOffsetX * 1000).toFixed(0)}mm</span>
          </div>
        </div>
      )}

      {/* Input bars removed — shown on 2D track map panel + 3D input overlay */}
    </div>
  );
});
