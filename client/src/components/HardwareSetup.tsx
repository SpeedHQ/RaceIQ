import { useState } from "react";
import fanatec15nm from "@shared/setup/fanatec-15nm.json";
import { SearchSelect } from "./ui/SearchSelect";

interface Setting {
  name: string;
  value: string;
  unit?: string;
  description: string;
}

interface SettingsGroup {
  title: string;
  description: string;
  settings: Setting[];
}

interface InGamePreset {
  id: string;
  name: string;
  description: string;
  settings: Setting[];
}

interface CarOverride {
  carOrdinal: number;
  carName: string;
  notes: string;
  overrides: Setting[];
}

interface HardwareProfile {
  id: string;
  name: string;
  description: string;
  sources: string[];
  wheelBase: { name: string; maxTorque: string; notes: string };
  fanalab: SettingsGroup;
  inGamePresets: InGamePreset[];
  perCarOverrides: CarOverride[];
  tips: string[];
}

const PROFILES: HardwareProfile[] = [fanatec15nm as HardwareProfile];

function SettingsTable({ group }: { group: SettingsGroup }) {
  return (
    <div className="rounded-xl bg-app-surface/40 ring-1 ring-app-border overflow-hidden">
      <div className="px-4 py-3 border-b border-app-border">
        <h3 className="text-app-heading font-semibold text-app-text">{group.title}</h3>
        <p className="text-app-subtext text-app-text-muted mt-0.5">{group.description}</p>
      </div>
      <div className="divide-y divide-app-border">
        {group.settings.map((s) => (
          <div key={s.name} className="px-4 py-2.5 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-app-body font-semibold text-app-text">{s.name}</div>
              <p className="text-app-subtext text-app-text-muted mt-0.5 leading-relaxed">{s.description}</p>
            </div>
            <div className="shrink-0 text-right">
              <span className="text-app-body font-bold font-mono text-app-accent">{s.value}</span>
              {s.unit && <span className="text-app-label text-app-text-muted ml-0.5">{s.unit}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PresetSettingsTable({ preset }: { preset: InGamePreset }) {
  return (
    <div className="rounded-xl bg-app-surface/40 ring-1 ring-app-border overflow-hidden">
      <div className="divide-y divide-app-border">
        {preset.settings.map((s) => (
          <div key={s.name} className="px-4 py-2.5 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-app-body font-semibold text-app-text">{s.name}</div>
              <p className="text-app-subtext text-app-text-muted mt-0.5 leading-relaxed">{s.description}</p>
            </div>
            <div className="shrink-0 text-right">
              <span className="text-app-body font-bold font-mono text-app-accent">{s.value}</span>
              {s.unit && <span className="text-app-label text-app-text-muted ml-0.5">{s.unit}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function HardwareSetup() {
  const [selectedProfile, setSelectedProfile] = useState(PROFILES[0].id);
  const profile = PROFILES.find((p) => p.id === selectedProfile) ?? PROFILES[0];
  const [activePreset, setActivePreset] = useState(profile.inGamePresets[0].id);
  const preset = profile.inGamePresets.find((p) => p.id === activePreset) ?? profile.inGamePresets[0];

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4 max-w-xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-app-title font-bold text-app-text">Hardware Setup</h1>
            <span className="text-app-unit font-semibold uppercase px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400">
              {profile.wheelBase.maxTorque}
            </span>
          </div>
          <p className="text-app-subtext text-app-text-muted">{profile.description}</p>
        </div>

        {PROFILES.length > 1 && (
          <SearchSelect
            value={selectedProfile}
            onChange={(v) => {
              setSelectedProfile(v);
              const p = PROFILES.find((pr) => pr.id === v);
              if (p) setActivePreset(p.inGamePresets[0].id);
            }}
            options={PROFILES.map((p) => ({ value: p.id, label: p.name }))}
            placeholder="Search profiles..."
            className="w-56"
          />
        )}
      </div>

      <div className="rounded-lg bg-app-bg/60 p-3">
        <p className="text-app-subtext text-app-text-secondary">{profile.wheelBase.notes}</p>
      </div>

      <SettingsTable group={profile.fanalab} />

      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-app-heading font-semibold text-app-text">In-Game FFB Settings</h3>
            <p className="text-app-subtext text-app-text-muted mt-0.5">Settings → Controls → Advanced → Wheel FFB</p>
          </div>
        </div>

        <div className="flex gap-2 mb-3">
          {profile.inGamePresets.map((p) => (
            <button
              key={p.id}
              onClick={() => setActivePreset(p.id)}
              className={`text-app-label font-semibold uppercase px-2.5 py-1.5 rounded-lg transition-colors ${
                activePreset === p.id
                  ? "bg-app-accent/20 text-app-accent ring-1 ring-app-accent/30"
                  : "bg-app-surface/40 text-app-text-muted hover:text-app-text-secondary ring-1 ring-app-border"
              }`}
            >
              {p.name}
            </button>
          ))}
        </div>

        <div className="rounded-lg bg-app-bg/60 p-2.5 mb-3">
          <p className="text-app-subtext text-app-text-secondary">{preset.description}</p>
        </div>

        <PresetSettingsTable preset={preset} />
      </div>

      {profile.perCarOverrides.length > 0 && (
        <div className="rounded-xl bg-app-surface/40 ring-1 ring-app-border overflow-hidden">
          <div className="px-4 py-3 border-b border-app-border">
            <h3 className="text-app-heading font-semibold text-app-text">Per-Car Overrides</h3>
            <p className="text-app-subtext text-app-text-muted mt-0.5">Adjustments for specific cars</p>
          </div>
          <div className="divide-y divide-app-border">
            {profile.perCarOverrides.map((car) => (
              <div key={car.carOrdinal} className="px-4 py-3">
                <div className="text-app-body font-semibold text-app-text">{car.carName}</div>
                <p className="text-app-subtext text-app-text-muted mt-0.5 mb-2">{car.notes}</p>
                {car.overrides.map((o) => (
                  <div key={o.name} className="flex items-center justify-between py-1">
                    <span className="text-app-body text-app-text-secondary">{o.name}</span>
                    <span className="text-app-body font-bold font-mono text-app-accent">
                      {o.value}{o.unit && <span className="text-app-text-muted ml-0.5">{o.unit}</span>}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-xl bg-app-surface/40 ring-1 ring-app-border overflow-hidden">
        <div className="px-4 py-3 border-b border-app-border">
          <h3 className="text-app-heading font-semibold text-app-text">Tips</h3>
        </div>
        <ul className="px-4 py-3 space-y-2">
          {profile.tips.map((tip, i) => (
            <li key={i} className="text-app-body text-app-text-secondary flex items-start gap-2">
              <span className="text-app-accent shrink-0 mt-0.5">{i + 1}.</span>
              {tip}
            </li>
          ))}
        </ul>
      </div>

      {profile.sources.length > 0 && (
        <div className="text-app-label text-app-text-muted space-y-0.5">
          <div className="font-semibold uppercase tracking-wider">Sources</div>
          {profile.sources.map((src) => (
            <a key={src} href={src} target="_blank" rel="noopener noreferrer" className="block hover:text-app-text-secondary truncate">
              {src}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
