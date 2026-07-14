import { m } from "../../paraglide/messages";
import { X } from "lucide-react";
import { Button } from "../ui/button";

interface SectionProps {
  title: string;
  children: React.ReactNode;
}

function Section({ title, children }: SectionProps) {
  return (
    <div>
      <h3 className="text-[11px] uppercase tracking-wider font-semibold text-app-text-muted mb-2 pb-1 border-b border-app-border">{title}</h3>
      <div className="space-y-1.5 text-[11px] font-mono">{children}</div>
    </div>
  );
}

function Row({ label, desc }: { label: string; desc: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="text-app-text w-24 shrink-0">{label}</span>
      <span className="text-app-text-muted leading-relaxed">{desc}</span>
    </div>
  );
}

function ColorDot({ color }: { color: string }) {
  return <span className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: color }} />;
}

export function DataGuideModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-app-surface border border-app-border rounded-xl shadow-2xl w-[560px] max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-app-border shrink-0">
          <h2 className="text-sm font-semibold text-app-text">{m.analyse_data_guide_title()}</h2>
          <Button variant="app-ghost" size="app-sm" onClick={onClose}>
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
                    <ColorDot color="#34d399" />
                    GRIP — within grip budget (Grip Ask &lt; 90%)
                  </span>
                  <span className="block">
                    <ColorDot color="#fbbf24" />
                    SLIP — at the edge (Grip Ask 90–100%)
                  </span>
                  <span className="block">
                    <ColorDot color="#f97316" />
                    SPIN — past peak, longitudinal axis dominant
                  </span>
                  <span className="block">
                    <ColorDot color="#ef4444" />
                    SLIDE — past peak, lateral axis dominant
                  </span>
                  <span className="block">
                    <ColorDot color="#ef4444" />
                    LOCK — wheel stopped or dragging under braking
                  </span>
                  <span className="block">
                    <ColorDot color="#6b7280" />
                    IDLE — stationary
                  </span>
                </span>
              }
            />
            <Row
              label={m.dataguide_temp()}
              desc={
                <>
                  Tire surface temperature zone: <ColorDot color="#3b82f6" />
                  cold · <ColorDot color="#34d399" />
                  optimal · <ColorDot color="#fbbf24" />
                  hot · <ColorDot color="#ef4444" />
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
            <Row label={m.dataguide_ratio()} desc="Wheel speed vs ground speed. High ratio = wheelspin/lockup. Colour: green &lt;10% · amber &lt;30% · red beyond." />
            <Row label={m.dataguide_angle()} desc="Angle between wheel heading and direction of travel. Peak mechanical grip is typically 6–12° (speed-dependent). Thresholds scale down at low speed." />
          </Section>

          {/* Wheels */}
          <Section title={m.dataguide_wheels()}>
            <Row label={m.dataguide_rotation_s()} desc="Wheel angular velocity in rad/s. Spikes sharply during wheelspin." />
            <Row
              label={m.dataguide_temp()}
              desc={
                <>
                  {m.dataguide_surface_temp()} <ColorDot color="#3b82f6" />
                  cold · <ColorDot color="#34d399" />
                  optimal · <ColorDot color="#fbbf24" />
                  hot · <ColorDot color="#ef4444" />
                  critical
                </>
              }
            />
            <Row
              label={m.dataguide_health()}
              desc={
                <>
                  {m.dataguide_tire_wear_remaining()} <span className="text-app-text">100%</span> = new. <ColorDot color="#34d399" />
                  &gt;70% · <ColorDot color="#fbbf24" />
                  &gt;40% · <ColorDot color="#ef4444" />
                  below
                </>
              }
            />
            <Row label={m.dataguide_wear_s()} desc="% of tire worn per second at the current intensity, measured over the last lap." />
            <Row
              label={m.dataguide_brake()}
              desc={
                <>
                  {m.dataguide_brake_disc_temp()} <ColorDot color="#3b82f6" />
                  cold · <ColorDot color="#34d399" />
                  working range · <ColorDot color="#fbbf24" />
                  hot · <ColorDot color="#ef4444" />
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
                  Normalised suspension travel (0–100%). <ColorDot color="#3b82f6" />
                  compressed · <ColorDot color="#34d399" />
                  mid-range · <ColorDot color="#fbbf24" />
                  extended · <ColorDot color="#ef4444" />
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
