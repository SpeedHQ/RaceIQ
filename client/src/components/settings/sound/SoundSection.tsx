import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getSoundEnabled, getSoundType, getSoundUrl, getSoundVolume, SOUND_PRESETS, setSoundEnabled, setSoundType, setSoundUrl, setSoundVolume } from "@/lib/settings-storage";
import { m } from "@/paraglide/messages";
import { playBlip, preloadSound, removeCachedSound } from "../../SectorTimes";

export function SoundSection() {
  const [soundEnabled, setSoundEnabledState] = useState(() => getSoundEnabled());
  const [soundVolume, setSoundVolumeState] = useState(() => getSoundVolume());
  const [soundType, setSoundTypeState] = useState(() => getSoundType());
  const [soundUrl, setSoundUrlState] = useState(() => getSoundUrl());
  return (
    <section>
      <h2 className="text-lg font-semibold text-app-text mb-1">{m.label_sound()}</h2>
      <p className="text-sm text-app-text-muted mb-4">{m.settings_sound_desc()}</p>
      <div className="flex items-center gap-3 mb-4">
        <Label className="text-app-text-secondary">{m.settings_sound_sector_blip()}</Label>
        <Button
          size="sm"
          variant={soundEnabled ? "selected-toggle" : "outline"}
          onClick={() => {
            setSoundEnabledState(true);
            setSoundEnabled(true);
          }}
        >
          {m.common_on()}
        </Button>
        <Button
          size="sm"
          variant={!soundEnabled ? "selected-toggle" : "outline"}
          onClick={() => {
            setSoundEnabledState(false);
            setSoundEnabled(false);
          }}
        >
          {m.common_off()}
        </Button>
      </div>
      <div className="mb-4">
        <Label className="text-app-text-secondary mb-2 block">{m.settings_sound_preset()}</Label>
        <div className="flex flex-wrap gap-1.5">
          {SOUND_PRESETS.map((p) => (
            <Button
              key={p.id}
              size="sm"
              variant={soundType === p.id ? "default" : "outline"}
              onClick={() => {
                setSoundTypeState(p.id);
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
      {soundType === "url" && (
        <div className="mb-4">
          <Label htmlFor="sound-url" className="text-app-text-secondary mb-2 block">
            {m.settings_sound_url_label()}
          </Label>
          <p className="text-xs text-app-text-muted mb-2">{m.settings_sound_url_desc()}</p>
          <div className="flex gap-2">
            <Input id="sound-url" value={soundUrl} onChange={(e) => setSoundUrlState(e.target.value)} placeholder="https://example.com/beep.mp3" className="flex-1" />
            <Button
              size="sm"
              onClick={() => {
                const previousUrl = getSoundUrl();
                setSoundUrl(soundUrl);
                if (previousUrl !== soundUrl) removeCachedSound(previousUrl);
                if (soundUrl) preloadSound(soundUrl);
              }}
            >
              {m.common_save()}
            </Button>
          </div>
        </div>
      )}
      <div className="mb-4">
        <Label htmlFor="sound-volume" className="text-app-text-secondary mb-2 block">
          {m.label_volume()} — {Math.round(soundVolume * 100)}%
        </Label>
        <input
          id="sound-volume"
          type="range"
          min="0"
          max="100"
          value={Math.round(soundVolume * 100)}
          onChange={(e) => {
            const v = Number.parseInt(e.target.value, 10) / 100;
            setSoundVolumeState(v);
            setSoundVolume(v);
          }}
          className="w-64 accent-app-accent"
        />
      </div>
      <div>
        <Label className="text-app-text-secondary mb-2 block">{m.label_preview()}</Label>
        <Button size="sm" variant="outline" onClick={() => playBlip(1.25)}>
          {m.settings_sound_play()}
        </Button>
      </div>
    </section>
  );
}
