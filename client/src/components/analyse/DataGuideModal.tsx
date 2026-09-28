import { X } from "lucide-react";
import { operatingColor, severityColor } from "../../lib/colors";
import { m } from "../../paraglide/messages";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent size="lg" showCloseButton={false} overlayClassName="bg-app-bg/60" className="@container/data-guide flex min-h-0 max-h-[85vh] max-w-[560px] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="flex shrink-0 flex-row items-center justify-between gap-0 border-b border-app-border px-5 py-3">
          <DialogTitle id="analyse-data-guide-title" className="text-sm font-semibold text-app-text">
            {m.analyse_data_guide_title()}
          </DialogTitle>
          <Button variant="app-ghost" size="app-sm" aria-label={m.common_close()} onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </DialogHeader>
        {/* Scrollable content */}
        <div className="min-h-0 overflow-y-auto px-5 py-4 space-y-5">
          {/* Metrics */}
          <Section title={m.dataguide_metrics()}>
            <Row label={m.dataguide_speed()} desc={m.dataguide_desc_speed()} />
            <Row label={m.dataguide_rpm()} desc={m.dataguide_desc_rpm()} />
            <Row label={m.dataguide_gear()} desc={m.dataguide_desc_gear()} />
            <Row label={m.dataguide_throttle_brake()} desc={m.dataguide_desc_throttle_brake()} />
            <Row label={m.dataguide_steer()} desc={m.dataguide_desc_steer()} />
            <Row label={m.dataguide_boost()} desc={m.dataguide_desc_boost()} />
            <Row label={m.dataguide_power_torque()} desc={m.dataguide_desc_power_torque()} />
            <Row label={m.dataguide_fuel()} desc={m.dataguide_desc_fuel()} />
          </Section>

          {/* Dynamics */}
          <Section title={m.dataguide_dynamics()}>
            <Row
              label={m.dataguide_balance()}
              desc={
                <>
                  {m.dataguide_desc_balance()}
                </>
              }
            />
            <Row label={m.dataguide_g_force()} desc={m.dataguide_desc_g_force()} />
            <Row
              label={m.dataguide_grip_ask()}
              desc={m.dataguide_desc_grip_ask()}
            />
            <Row
              label={m.dataguide_traction()}
              desc={
                <span className="space-y-0.5 block">
                  <span className="block"><SeverityDot level={0} />{m.dataguide_traction_grip()}</span>
                  <span className="block"><SeverityDot level={1} />{m.dataguide_traction_slip()}</span>
                  <span className="block"><SeverityDot level={2} />{m.dataguide_traction_spin()}</span>
                  <span className="block"><SeverityDot level={3} />{m.dataguide_traction_slide()}</span>
                  <span className="block"><SeverityDot level={3} />{m.dataguide_traction_lock()}</span>
                  <span className="block"><ColorDot color="var(--app-text-dim)" />{m.dataguide_traction_idle()}</span>
                </span>
              }
            />
            <Row
              label={m.dataguide_temp()}
              desc={
                <>
                  {m.dataguide_desc_tire_temperature()} <TireTemperatureDot state="cold" />{m.dataguide_cold()} · <TireTemperatureDot state="optimal" />{m.dataguide_optimal()} · <TireTemperatureDot state="hot" />{m.dataguide_hot()} · <TireTemperatureDot state="critical" />{m.dataguide_critical()}
                </>
              }
            />
            <Row
              label={m.dataguide_surface()}
              desc={
                <>
                  <span className="text-app-text">CURB</span> {m.dataguide_surface_curb()} · <span className="text-app-text">WET XX%</span> {m.dataguide_surface_wet()}
                </>
              }
            />
          </Section>

          {/* Slip */}
          <Section title={m.dataguide_slip()}>
            <Row label={m.dataguide_ratio()} desc={m.dataguide_desc_ratio()} />
            <Row label={m.dataguide_angle()} desc={m.dataguide_desc_angle()} />
          </Section>

          {/* Wheels */}
          <Section title={m.dataguide_wheels()}>
            <Row label={m.dataguide_rotation_s()} desc={m.dataguide_desc_rotation()} />
            <Row
              label={m.dataguide_temp()}
              desc={
                <>
                  {m.dataguide_surface_temp()} <TireTemperatureDot state="cold" />{m.dataguide_cold()} · <TireTemperatureDot state="optimal" />{m.dataguide_optimal()} · <TireTemperatureDot state="hot" />{m.dataguide_hot()} · <TireTemperatureDot state="critical" />{m.dataguide_critical()}
                </>
              }
            />
            <Row
              label={m.dataguide_health()}
              desc={
                <>
                  {m.dataguide_tire_wear_remaining()} <span className="text-app-text">100%</span> {m.dataguide_wear_new()} <SeverityDot level={0} />&gt;70% · <SeverityDot level={1} />&gt;40% · <SeverityDot level={3} />{m.dataguide_wear_low()}
                </>
              }
            />
            <Row label={m.dataguide_wear_s()} desc={m.dataguide_desc_wear_rate()} />
            <Row
              label={m.dataguide_brake()}
              desc={
                <>
                  {m.dataguide_brake_disc_temp()} <BrakeTemperatureDot state="cold" />{m.dataguide_cold()} · <BrakeTemperatureDot state="working" />{m.dataguide_working_range()} · <BrakeTemperatureDot state="hot" />{m.dataguide_overheating()}
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
                  {m.dataguide_desc_suspension_travel()} <OperatingDot level={0} />{m.dataguide_compressed()} · <OperatingDot level={1} />{m.dataguide_mid_range()} · <OperatingDot level={2} />{m.dataguide_extended()} · <OperatingDot level={3} />{m.dataguide_near_limit()}
                </>
              }
            />
            <Row label={m.dataguide_load()} desc={m.dataguide_desc_load()} />
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
