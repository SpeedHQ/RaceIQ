import { X } from "lucide-react";
import { Button } from "../ui/button";

interface SectionProps {
  title: string;
  children: React.ReactNode;
}

function Section({ title, children }: SectionProps) {
  return (
    <div>
      <h3 className="text-[11px] uppercase tracking-wider font-semibold text-app-text-muted mb-2 pb-1 border-b border-app-border">
        {title}
      </h3>
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
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-app-surface border border-app-border rounded-xl shadow-2xl w-[560px] max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-app-border shrink-0">
          <h2 className="text-sm font-semibold text-app-text">Data Panel Guide</h2>
          <Button variant="app-ghost" size="app-sm" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Scrollable content */}
        <div className="overflow-y-auto px-5 py-4 space-y-5">

          {/* Metrics */}
          <Section title="Metrics">
            <Row label="Speed" desc="Current vehicle speed in selected units." />
            <Row label="RPM" desc="Engine revolutions per minute." />
            <Row label="Gear" desc="Current gear (0 = reverse, 1–n = forward)." />
            <Row label="Throttle / Brake" desc="Pedal input as % of full travel (0–100%)." />
            <Row label="Steer" desc="Steering wheel angle in degrees, scaled to your steering lock setting." />
            <Row label="Boost" desc="Turbo/supercharger boost pressure in PSI above atmospheric." />
            <Row label="Power / Torque" desc="Engine output at the current RPM." />
            <Row label="Fuel" desc="% consumed since lap start · % remaining in tank." />
          </Section>

          {/* Dynamics */}
          <Section title="Dynamics">
            <Row label="Balance" desc={<>Understeer/oversteer via front vs rear slip angle delta (Milliken method, EMA-smoothed). <span className="text-app-text">+δ</span> = fronts slide more (understeer) · <span className="text-app-text">−δ</span> = rears slide more (oversteer).</>} />
            <Row label="G-Force" desc="Lateral (cornering) and longitudinal (braking/acceleration) g-forces." />
            <Row label="Grip Ask" desc={<>Friction circle utilisation per tire. <span className="text-app-text">100%</span> = exactly at the grip limit · <span className="text-app-text">&gt;100%</span> = exceeding it.</>} />
            <Row label="Traction" desc={
              <span className="space-y-0.5 block">
                <span className="block"><ColorDot color="#34d399" />GRIP — normal rolling</span>
                <span className="block"><ColorDot color="#fbbf24" />SLIP — mild combined slip (&gt;0.5)</span>
                <span className="block"><ColorDot color="#f97316" />SLIDE — significant slip (&gt;1.0)</span>
                <span className="block"><ColorDot color="#ef4444" />LOSS — over grip limit (&gt;2.0)</span>
                <span className="block"><ColorDot color="#f97316" />SPIN — wheelspin detected</span>
                <span className="block"><ColorDot color="#ef4444" />LOCK — brake lockup detected</span>
                <span className="block"><ColorDot color="#6b7280" />IDLE — wheel stopped</span>
              </span>
            } />
            <Row label="Temp" desc={<>Tire surface temperature zone: <ColorDot color="#3b82f6" />cold · <ColorDot color="#34d399" />optimal · <ColorDot color="#fbbf24" />hot · <ColorDot color="#ef4444" />critical</>} />
            <Row label="Surface" desc={<><span className="text-app-text">CURB</span> = on a rumble strip · <span className="text-app-text">WET XX%</span> = puddle at XX% depth</>} />
          </Section>

          {/* Slip */}
          <Section title="Slip">
            <Row label="Ratio" desc="Wheel speed vs ground speed. High ratio = wheelspin/lockup. Colour: green &lt;10% · amber &lt;30% · red beyond." />
            <Row label="Angle" desc="Angle between wheel heading and direction of travel. Peak mechanical grip is typically 6–12° (speed-dependent). Thresholds scale down at low speed." />
          </Section>

          {/* Wheels */}
          <Section title="Wheels">
            <Row label="Rotation /s" desc="Wheel angular velocity in rad/s. Spikes sharply during wheelspin." />
            <Row label="Temp" desc={<>Surface temperature. <ColorDot color="#3b82f6" />cold · <ColorDot color="#34d399" />optimal · <ColorDot color="#fbbf24" />hot · <ColorDot color="#ef4444" />critical</>} />
            <Row label="Health" desc={<>Tire wear remaining. <span className="text-app-text">100%</span> = new. <ColorDot color="#34d399" />&gt;70% · <ColorDot color="#fbbf24" />&gt;40% · <ColorDot color="#ef4444" />below</>} />
            <Row label="Wear /s" desc="% of tire worn per second at the current intensity, measured over the last lap." />
            <Row label="Brake" desc={<>Brake disc temperature. <ColorDot color="#3b82f6" />cold · <ColorDot color="#34d399" />working range · <ColorDot color="#fbbf24" />hot · <ColorDot color="#ef4444" />overheating</>} />
          </Section>

          {/* Suspension */}
          <Section title="Suspension">
            <Row label="Travel" desc={<>Normalised suspension travel (0–100%). <ColorDot color="#3b82f6" />compressed · <ColorDot color="#34d399" />mid-range · <ColorDot color="#fbbf24" />extended · <ColorDot color="#ef4444" />near limit</>} />
            <Row label="Load" desc="Weight distribution. Lon 50% = balanced front/rear · Lat 50% = balanced left/right. Shifts during acceleration, braking, and cornering." />
          </Section>

        </div>
      </div>
    </div>
  );
}
