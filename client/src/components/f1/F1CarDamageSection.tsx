import { severityRangeColor } from "@/lib/colors";
import type { LiveTelemetryView } from "../../lib/live-telemetry-view";

export interface F1CarDamageLabels {
  title: string;
  allClear: string;
  frontLeftWing: string;
  frontRightWing: string;
  rearWing: string;
  floor: string;
  diffuser: string;
  sidepod: string;
  ok: string;
}

const DEFAULT_LABELS: F1CarDamageLabels = {
  title: "Damage",
  allClear: "All Clear",
  frontLeftWing: "FL Wing",
  frontRightWing: "FR Wing",
  rearWing: "Rear Wing",
  floor: "Floor",
  diffuser: "Diffuser",
  sidepod: "Sidepod",
  ok: "OK",
};

export function F1CarDamageSection({
  damage,
  labels = DEFAULT_LABELS,
}: {
  damage: LiveTelemetryView["damage"];
  labels?: Readonly<F1CarDamageLabels>;
}) {
  const parts = [
    { label: labels.frontLeftWing, value: damage.frontLeftWingPct },
    { label: labels.frontRightWing, value: damage.frontRightWingPct },
    { label: labels.rearWing, value: damage.rearWingPct },
    { label: labels.floor, value: damage.floorPct },
    { label: labels.diffuser, value: damage.diffuserPct },
    { label: labels.sidepod, value: damage.sidepodPct },
  ];
  const availablePartCount = parts.filter((part) => part.value !== undefined).length;
  const hasDamage = parts.some((part) => part.value !== undefined && part.value > 0);
  const damageColor = (value: number | undefined) => (value === undefined ? "var(--status-unavailable)" : severityRangeColor(value, [1, 30, 60]));

  return (
    <div className="border-b border-app-border">
      <div className="h-8 px-2 border-b border-app-border flex items-center justify-between">
        <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">{labels.title}</h2>
        {availablePartCount > 0 && !hasDamage && <span className="text-xs text-status-success">{labels.allClear}</span>}
      </div>
      <div className="p-3 flex items-center gap-4">
        <svg viewBox="0 0 100 200" className="w-16 h-32 flex-shrink-0">
          <path
            d="M40,30 L35,15 L40,5 L60,5 L65,15 L60,30 L62,50 L65,70 L65,140 L62,160 L60,175 L58,190 L42,190 L40,175 L38,160 L35,140 L35,70 L38,50 Z"
            fill="var(--app-surface-alt)"
            stroke="var(--app-border)"
            strokeWidth="1.5"
          />
          <rect x="15" y="8" width="22" height="6" rx="1" fill={damageColor(damage.frontLeftWingPct)} opacity="0.8" />
          <rect x="63" y="8" width="22" height="6" rx="1" fill={damageColor(damage.frontRightWingPct)} opacity="0.8" />
          <rect x="30" y="185" width="40" height="6" rx="1" fill={damageColor(damage.rearWingPct)} opacity="0.8" />
          <rect x="36" y="80" width="28" height="50" rx="2" fill={damageColor(damage.floorPct)} opacity="0.3" />
          <rect x="35" y="175" width="30" height="5" rx="1" fill={damageColor(damage.diffuserPct)} opacity="0.6" />
          <rect x="28" y="70" width="6" height="30" rx="2" fill={damageColor(damage.sidepodPct)} opacity="0.7" />
          <rect x="66" y="70" width="6" height="30" rx="2" fill={damageColor(damage.sidepodPct)} opacity="0.7" />
          <rect x="20" y="20" width="12" height="24" rx="3" fill="var(--app-surface)" stroke="var(--app-border)" strokeWidth="1" />
          <rect x="68" y="20" width="12" height="24" rx="3" fill="var(--app-surface)" stroke="var(--app-border)" strokeWidth="1" />
          <rect x="18" y="140" width="14" height="28" rx="3" fill="var(--app-surface)" stroke="var(--app-border)" strokeWidth="1" />
          <rect x="68" y="140" width="14" height="28" rx="3" fill="var(--app-surface)" stroke="var(--app-border)" strokeWidth="1" />
          <ellipse cx="50" cy="65" rx="8" ry="12" fill="var(--app-bg)" stroke="var(--app-border)" strokeWidth="1" />
          <path d="M44,58 Q50,50 56,58" fill="none" stroke="var(--app-text-dim)" strokeWidth="2" />
        </svg>
        <div className="flex-1 grid grid-cols-2 gap-x-3 gap-y-1.5">
          {parts.map((part) => (
            <div key={part.label} className="flex items-center justify-between">
              <span className="text-xs text-app-text-muted">{part.label}</span>
              <span className="text-sm font-mono font-bold tabular-nums" style={{ color: damageColor(part.value) }}>
                {part.value === undefined ? "—" : part.value === 0 ? labels.ok : `${part.value}%`}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
