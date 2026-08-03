import { X } from "lucide-react";
import { operatingColor, severityColor } from "../../lib/colors";
import { m } from "../../paraglide/messages";
import { Button } from "../ui/button";

interface SectionProps {
  title: string;
  children: React.ReactNode;
}

function Section({ title, children }: SectionProps) {
  return (
    <div>
      <h3 className="text-app-compact uppercase tracking-wider font-semibold text-app-text-muted mb-2 pb-1 border-b border-app-border">{title}</h3>
      <div className="space-y-1.5 text-app-compact font-mono">{children}</div>
    </div>
  );
}

function Row({ label, desc }: { label: string; desc: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 @sm/data-guide:flex-row @sm/data-guide:gap-3">
      <span className="w-full shrink-0 text-app-text @sm/data-guide:w-24">{label}</span>
      <span className="text-app-text-muted leading-relaxed">{desc}</span>
    </div>
  );
}

function ColorDot({ color }: { color: string }) {
  return <span className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: color }} />;
}

function SeverityDot({ level }: { level: 0 | 1 | 2 | 3 }) {
  return <ColorDot color={severityColor(level)} />;
}

function OperatingDot({ level }: { level: 0 | 1 | 2 | 3 }) {
  return <ColorDot color={operatingColor(level)} />;
}

function TireTemperatureDot({ state }: { state: "cold" | "optimal" | "hot" | "critical" }) {
  if (state === "cold") return <OperatingDot level={0} />;
  if (state === "optimal") return <SeverityDot level={0} />;
  if (state === "hot") return <ColorDot color="var(--tire-temperature-hot)" />;
  return <SeverityDot level={3} />;
}

function BrakeTemperatureDot({ state }: { state: "cold" | "working" | "hot" }) {
  if (state === "cold") return <OperatingDot level={0} />;
  return <SeverityDot level={state === "working" ? 2 : 3} />;
}

export function DataGuideModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="@container/data-guide fixed inset-0 z-50 flex items-center justify-center p-3">
      <button type="button" aria-label={m.common_close()} className="absolute inset-0 bg-app-bg/60" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="analyse-data-guide-title"
        className="relative flex max-h-[85vh] w-full max-w-[560px] flex-col rounded-xl border border-app-border bg-app-surface shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-app-border shrink-0">
          <h2 id="analyse-data-guide-title" className="text-sm font-semibold text-app-text">
            {m.analyse_data_guide_title()}
          </h2>
          <Button variant="app-ghost" size="app-sm" aria-label={m.common_close()} onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Scrollable content */}
        <div className="overflow-y-auto px-5 py-4 space-y-5">
          {/* Metrics */}
          <Section title={m.dataguide_metrics()}>
            <Row label={m.dataguide_speed()} desc="Current vehicle speed in selected units." />
            <Row label={m.dataguide_rpm()} desc="Engine revolutions per minute." />
            <Row label={m.dataguide_gear()} desc="Current gear (0 = reverse, 1–n = forward)." />
            <Row label={m.dataguide_throttle_brake()} desc="Pedal input as % of full travel (0–100%)." />
            <Row label={m.dataguide_steer()} desc="Steering wheel angle in degrees, scaled to your steering lock setting." />
            <Row label={m.dataguide_boost()} desc="Turbo/supercharger boost pressure in PSI above atmospheric." />
            <Row label={m.dataguide_power_torque()} desc="Engine output at the current RPM." />
            <Row label={m.dataguide_fuel()} desc="% consumed since lap start · % remaining in tank." />
          </Section>

          {/* Dynamics */}
          <Section title={m.dataguide_dynamics()}>
            <Row
              label={m.dataguide_balance()}
              desc={
                <>
                  Hybrid understeer/oversteer detector. Combines two independent physics signals: <span className="text-app-text">yaw rate vs path curvature</span> (ω compared to Aᵧ/V — MoTeC/VBox
                  standard) and <span className="text-app-text">front−rear slip angle delta</span>. <span className="text-app-text">+</span> = understeer (fronts outrunning rears) ·{" "}
                  <span className="text-app-text">−</span> = oversteer (body yawing past path). Gated by <span className="text-app-text">|latG| ≥ 0.25g</span>, so straight-line wheelspin or lockup
                  never counts as balance.
                </>
              }
            />
            <Row label={m.dataguide_g_force()} desc="Lateral (cornering) and longitudinal (braking/acceleration) g-forces." />
            <Row
              label={m.dataguide_grip_ask()}
              desc={
                <>
                  Friction circle utilisation per tire, from physics signals: <span className="text-app-text">hypot(|slipRatio|/0.15, |slipAngle|/10°)</span>. Slip ratio is derived from wheel rotation
                  vs ground speed (SAE J670, not the game's raw slip field). <span className="text-app-text">100%</span> = at peak grip · <span className="text-app-text">&gt;100%</span> = past peak.{" "}
                  Universal across FM, F1, and ACC.
                </>
              }
            />
            <Row
              label={m.dataguide_traction()}
              desc={
                <span className="space-y-0.5 block">
                  <span className="block">
                    <SeverityDot level={0} />
                    GRIP — within grip budget (Grip Ask &lt; 90%)
                  </span>
                  <span className="block">
                    <SeverityDot level={1} />
                    SLIP — at the edge (Grip Ask 90–100%)
                  </span>
                  <span className="block">
                    <SeverityDot level={2} />
                    SPIN — past peak, longitudinal axis dominant
                  </span>
                  <span className="block">
                    <SeverityDot level={3} />
                    SLIDE — past peak, lateral axis dominant
                  </span>
                  <span className="block">
                    <SeverityDot level={3} />
                    LOCK — wheel stopped or dragging under braking
                  </span>
                  <span className="block">
                    <ColorDot color="var(--app-text-dim)" />
                    IDLE — stationary
                  </span>
                </span>
              }
            />
            <Row
              label={m.dataguide_temp()}
              desc={
                <>
                  Tire surface temperature zone: <TireTemperatureDot state="cold" />
                  cold · <TireTemperatureDot state="optimal" />
                  optimal · <TireTemperatureDot state="hot" />
                  hot · <TireTemperatureDot state="critical" />
                  critical
                </>
              }
            />
            <Row
              label={m.dataguide_surface()}
              desc={
                <>
                  <span className="text-app-text">CURB</span> = on a rumble strip · <span className="text-app-text">WET XX%</span> = puddle at XX% depth
                </>
              }
            />
          </Section>

          {/* Slip */}
          <Section title={m.dataguide_slip()}>
            <Row label={m.dataguide_ratio()} desc="Wheel speed vs ground speed. High ratio = wheelspin/lockup. State: nominal &lt;10% · caution &lt;30% · critical beyond." />
            <Row
              label={m.dataguide_angle()}
              desc="Angle between wheel heading and direction of travel. Peak mechanical grip is typically 6–12° (speed-dependent). Thresholds scale down at low speed."
            />
          </Section>

          {/* Wheels */}
          <Section title={m.dataguide_wheels()}>
            <Row label={m.dataguide_rotation_s()} desc="Wheel angular velocity in rad/s. Spikes sharply during wheelspin." />
            <Row
              label={m.dataguide_temp()}
              desc={
                <>
                  {m.dataguide_surface_temp()} <TireTemperatureDot state="cold" />
                  cold · <TireTemperatureDot state="optimal" />
                  optimal · <TireTemperatureDot state="hot" />
                  hot · <TireTemperatureDot state="critical" />
                  critical
                </>
              }
            />
            <Row
              label={m.dataguide_health()}
              desc={
                <>
                  {m.dataguide_tire_wear_remaining()} <span className="text-app-text">100%</span> = new. <SeverityDot level={0} />
                  &gt;70% · <SeverityDot level={1} />
                  &gt;40% · <SeverityDot level={3} />
                  below
                </>
              }
            />
            <Row label={m.dataguide_wear_s()} desc="% of tire worn per second at the current intensity, measured over the last lap." />
            <Row
              label={m.dataguide_brake()}
              desc={
                <>
                  {m.dataguide_brake_disc_temp()} <BrakeTemperatureDot state="cold" />
                  cold · <BrakeTemperatureDot state="working" />
                  working range · <BrakeTemperatureDot state="hot" />
                  overheating
                </>
              }
            />
          </Section>

          {/* Suspension */}
          <Section title={m.dataguide_suspension()}>
            <Row
              label={m.dataguide_travel()}
              desc={
                <>
                  Normalised suspension travel (0–100%). <OperatingDot level={0} />
                  compressed · <OperatingDot level={1} />
                  mid-range · <OperatingDot level={2} />
                  extended · <OperatingDot level={3} />
                  near limit
                </>
              }
            />
            <Row label={m.dataguide_load()} desc="Weight distribution. Lon 50% = balanced front/rear · Lat 50% = balanced left/right. Shifts during acceleration, braking, and cornering." />
          </Section>
        </div>
      </div>
    </div>
  );
}
