import { useState } from "react";
import { playBlip, preloadSound } from "@/components/SectorTimes";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { getSoundEnabled, getSoundType, getSoundVolume, SOUND_PRESETS, setSoundEnabled, setSoundType, setSoundVolume } from "@/lib/settings-storage";
import { m } from "@/paraglide/messages";

export function SoundStep() {
  const [enabled, setEnabled] = useState(() => getSoundEnabled());
  const [type, setType] = useState(() => getSoundType());
  const [volume, setVolume] = useState(() => getSoundVolume());
  return (
    <div>
      <h2 className="text-sm font-semibold text-app-text mb-1">{m.label_sound()}</h2>
      <p className="text-sm text-app-text-muted mb-4">{m.ob_sound_desc()}</p>
      <div className="flex items-center gap-3 mb-4">
        <Label className="text-app-text-secondary text-sm">{m.ob_sound_sector_blip()}</Label>
        <Button
          size="sm"
          variant={enabled ? "selected-toggle" : "outline"}
          onClick={() => {
            setEnabled(true);
            setSoundEnabled(true);
          }}
        >
          {m.common_on()}
        </Button>
        <Button
          size="sm"
          variant={!enabled ? "selected-toggle" : "outline"}
          onClick={() => {
            setEnabled(false);
            setSoundEnabled(false);
          }}
        >
          {m.common_off()}
        </Button>
      </div>
      {enabled && (
        <>
          <div className="mb-4">
            <Label className="text-app-text-secondary text-xs mb-2 block">{m.ob_sound_preset()}</Label>
            <div className="flex flex-wrap gap-1.5">
              {SOUND_PRESETS.map((p) => (
                <Button
                  key={p.id}
                  size="sm"
                  variant={type === p.id ? "default" : "outline"}
                  onClick={() => {
                    setType(p.id);
                    setSoundType(p.id);
                    if (p.id !== "url") preloadSound(`/sounds/${p.id}.mp3`);
                    playBlip(1);
                  }}
                  className="text-xs"
                >
                  {p.label}
                </Button>
              ))}
            </div>
          </div>
          <div className="mb-4">
            <Label className="text-app-text-secondary text-xs mb-2 block">
              {m.label_volume()} — {Math.round(volume * 100)}%
            </Label>
            <input
              type="range"
              min="0"
              max="100"
              value={Math.round(volume * 100)}
              onChange={(e) => {
                const v = Number.parseInt(e.target.value, 10) / 100;
                setVolume(v);
                setSoundVolume(v);
              }}
              className="w-64 accent-app-accent"
            />
          </div>
          <Button size="sm" variant="outline" onClick={() => playBlip(1.25)}>
            {m.label_preview()}
          </Button>
        </>
      )}
    </div>
  );
}
