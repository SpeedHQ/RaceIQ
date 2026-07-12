import { useState } from "react";
import fanatec15nm from "@shared/setup/fanatec-15nm.json";

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

interface WheelCatalogueEntry {
  profileId: string;
  name: string;
  subtitle: string;
  image: string;
  specs: string[];
}

const WHEEL_CATALOGUE: WheelCatalogueEntry[] = [
  {
    profileId: "fanatec-15nm",
    name: "Fanatec DD+ 15Nm",
    subtitle: "ClubSport F1 McLaren Wheel",
    image: "/fanatec-f1-wheel.webp",
    specs: ["Direct Drive", "15 Nm Peak Torque", "Fanalab Compatible"],
  },
];

export function WheelCatalogue({ onSelect }: { onSelect: (profileId: string) => void }) {
  return (
    <div className="flex-1 overflow-auto p-4 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-app-title font-bold text-app-text">Wheel Catalogue</h1>
        <p className="text-app-subtext text-app-text-muted mt-1">Select your wheel to view recommended FFB settings</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {WHEEL_CATALOGUE.map((wheel) => (
          <button
            key={wheel.profileId}
            onClick={() => onSelect(wheel.profileId)}
            className="group rounded-xl bg-app-surface/40 ring-1 ring-app-border hover:ring-app-accent/50 transition-all overflow-hidden text-left"
          >
            <div className="aspect-[16/10] bg-app-bg/60 flex items-center justify-center overflow-hidden">
              <img src={wheel.image} alt={wheel.name} className="w-full h-full object-contain p-4 group-hover:scale-105 transition-transform duration-300" />
            </div>
            <div className="p-4">
              <h3 className="text-app-heading font-semibold text-app-text">{wheel.name}</h3>
              <p className="text-app-subtext text-app-text-muted mt-0.5">{wheel.subtitle}</p>
              <div className="flex flex-wrap gap-1.5 mt-3">
                {wheel.specs.map((spec) => (
                  <span key={spec} className="text-app-label font-medium px-2 py-0.5 rounded-full bg-app-accent/10 text-app-accent ring-1 ring-app-accent/20">
                    {spec}
                  </span>
                ))}
              </div>
            </div>
          </button>
        ))}

        <div className="rounded-xl border-2 border-dashed border-app-border/50 flex items-center justify-center min-h-[200px] opacity-50">
          <div className="text-center p-4">
            <p className="text-app-body text-app-text-muted font-medium">More wheels coming soon</p>
          </div>
        </div>
      </div>
    </div>
  );
}

type DetailTab = "wheel" | "ingame";

export function HardwareSetupDetail({ profileId, onBack }: { profileId: string; onBack?: () => void }) {
  const profile = PROFILES.find((p) => p.id === profileId) ?? PROFILES[0];
  const [activeTab, setActiveTab] = useState<DetailTab>("wheel");
  const [activePreset, setActivePreset] = useState(profile.inGamePresets[0].id);
  const preset = profile.inGamePresets.find((p) => p.id === activePreset) ?? profile.inGamePresets[0];

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4 max-w-xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onBack} className="text-app-text-muted hover:text-app-text transition-colors" title="Back to catalogue">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                <path
                  fillRule="evenodd"
                  d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
            <h1 className="text-app-title font-bold text-app-text">Hardware Setup</h1>
            <span className="text-app-unit font-semibold uppercase px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400">{profile.wheelBase.maxTorque}</span>
          </div>
          <p className="text-app-subtext text-app-text-muted">{profile.description}</p>
        </div>
      </div>

      <div className="flex gap-2">
        {[
          { id: "wheel" as const, label: "Wheel Base" },
          { id: "ingame" as const, label: "In-Game FFB" },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`text-app-label font-semibold uppercase px-3 py-1.5 rounded-lg transition-colors ${
              activeTab === tab.id ? "bg-app-accent/20 text-app-accent ring-1 ring-app-accent/30" : "bg-app-surface/40 text-app-text-muted hover:text-app-text-secondary ring-1 ring-app-border"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "wheel" && (
        <>
          <div className="rounded-lg bg-app-bg/60 p-3">
            <p className="text-app-subtext text-app-text-secondary">{profile.wheelBase.notes}</p>
          </div>

          <SettingsTable group={profile.fanalab} />

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
        </>
      )}

      {activeTab === "ingame" && (
        <>
          <div className="flex gap-2">
            {profile.inGamePresets.map((p) => (
              <button
                key={p.id}
                onClick={() => setActivePreset(p.id)}
                className={`text-app-label font-semibold uppercase px-2.5 py-1.5 rounded-lg transition-colors ${
                  activePreset === p.id ? "bg-app-accent/20 text-app-accent ring-1 ring-app-accent/30" : "bg-app-surface/40 text-app-text-muted hover:text-app-text-secondary ring-1 ring-app-border"
                }`}
              >
                {p.name}
              </button>
            ))}
          </div>

          <div className="rounded-lg bg-app-bg/60 p-2.5">
            <p className="text-app-subtext text-app-text-secondary">{preset.description}</p>
          </div>

          <PresetSettingsTable preset={preset} />

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
                          {o.value}
                          {o.unit && <span className="text-app-text-muted ml-0.5">{o.unit}</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

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
