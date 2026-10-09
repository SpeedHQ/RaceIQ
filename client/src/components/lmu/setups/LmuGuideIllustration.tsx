import { useId, useState, type CSSProperties, type ReactNode } from "react";
import { Pause, Play } from "lucide-react";
import { m } from "@/paraglide/messages";
import { Button } from "@/components/ui/button";
import "./lmu-guide-illustration.css";
import { getLmuGuideContent } from "./lmu-guide-content";

// These are explanations, not simulations or setup-value scales.
function Tyre({ x, y = 150, tilt = 0, motion = "" }: { x: number; y?: number; tilt?: number; motion?: string }) {
  return <g transform={`translate(${x} ${y}) rotate(${tilt} 0 62)`}>
    <ellipse className="guide-object-shadow" cy="61" rx="48" ry="9" />
    <g className={motion}>
      <rect className="guide-rubber-side" x="-39" y="-62" width="78" height="124" rx="28" />
      <rect className="guide-rubber" x="-30" y="-62" width="60" height="124" rx="23" />
      <path className="guide-tyre-edge" d="M-24 38V-38Q-24 -53 -12 -55" />
      {[-36, -18, 0, 18, 36].map(y => <g key={y} opacity="0.7">
        <path className="guide-tread" d={`M-26 ${y - 6}L-8 ${y + 3}M8 ${y + 3}L26 ${y - 6}`} />
      </g>)}
      <path className="guide-tread" d="M-5 -54V54M5 -54V54" />
      <rect className="guide-tyre-band" x="-2" y="-58" width="4" height="116" rx="2" />
    </g>
  </g>;
}

function Force({ x, y, rotate = 0, small = false }: { x: number; y: number; rotate?: number; small?: boolean }) {
  return <g transform={`translate(${x} ${y}) rotate(${rotate}) scale(${small ? 0.65 : 1})`}>
    <g className="guide-motion-force">
      <path className="guide-force-tail" d="M-5 -32H5V5H15L0 24L-15 5H-5Z" />
      <path className="guide-force-echo" d="M-10 -43L0 -33L10 -43" />
    </g>
  </g>;
}

function Label({ x, y = 246, children }: { x: number; y?: number; children: ReactNode }) {
  return <text className="guide-label" x={x} y={y} textAnchor="middle">{children}</text>;
}
function Ground() {
  return <g>
    <ellipse className="guide-floor-shadow" cx="300" cy="216" rx="225" ry="15" />
    <path className="guide-ground-face" d="M65 211H535L550 223H50Z" />
    <rect className="guide-ground" x="50" y="223" width="500" height="5" rx="2" />
  </g>;
}

function Battery({ x = 370, charge = true }: { x?: number; charge?: boolean }) {
  return <g transform={`translate(${x} 100)`}>
    <ellipse className="guide-object-shadow" cx="65" cy="101" rx="83" ry="10" />
    <path className="guide-housing-side" d="M15 -8H127Q140 -8 140 6V72L125 90V10Z" />
    <rect className="guide-housing" width="125" height="90" rx="16" />
    <rect className="guide-battery-well" x="8" y="8" width="109" height="74" rx="10" />
    <rect className="guide-metal" x="125" y="30" width="9" height="30" rx="3" />
    {[0, 1, 2, 3].map(i => <rect key={i} className={`guide-energy-cell guide-motion-${charge ? "charge" : "drain"}`} style={{ animationDelay: `${i * -0.3}s` }} x={15 + i * 25} y="16" width="20" height="58" rx="5" />)}
    <path className="guide-battery-symbol" d="M68 27L50 48H63L56 65L76 43H63Z" />
  </g>;
}

function Disc({ x, hot = false }: { x: number; hot?: boolean }) {
  return <g transform={`translate(${x} 145)`}>
    <ellipse className="guide-object-shadow" cy="68" rx="70" ry="11" />
    <circle className="guide-disc-edge" cx="5" cy="3" r="61" />
    <circle className="guide-disc-face" r="58" />
    <circle className={hot ? "guide-disc-heat guide-motion-heat" : "guide-disc-heat"} r="50" opacity={hot ? 0.7 : 0.08} />
    <circle className="guide-disc-track" r="45" />
    <circle className="guide-disc-track" r="36" />
    <g className="guide-motion-spin">{[0, 45, 90, 135, 180, 225, 270, 315].map(angle => <g key={angle} transform={`rotate(${angle})`}>
      <rect className="guide-disc-slot" x="-3" y="-48" width="6" height="16" rx="3" transform="rotate(18 0 -40)" />
      <circle className="guide-disc-slot" cy="-28" r="2.5" />
    </g>)}</g>
    <circle className="guide-hub" r="22" />
    <circle className="guide-metal" r="11" />
    <circle className="guide-disc-slot" r="5" />
    <rect className="guide-caliper-side" x="38" y="-36" width="30" height="75" rx="11" />
    <rect className="guide-caliper" x="34" y="-39" width="27" height="70" rx="10" />
    <path className="guide-caliper-detail" d="M41 -24V19M48 -24V19" />
  </g>;
}

function Spring({ x, stiff = false }: { x: number; stiff?: boolean }) {
  return <g transform={`translate(${x} 55)`}>
    <ellipse className="guide-object-shadow" cy="163" rx="67" ry="9" />
    <rect className="guide-metal" x="-7" width="14" height="150" rx="7" />
    <rect className="guide-damper-shell" x="-15" y="76" width="30" height="65" rx="9" />
    <g className={`guide-motion-${stiff ? "stiff" : "spring"}`}>
      <rect className="guide-spring-seat" x="-43" y="138" width="86" height="16" rx="8" />
      <path className="guide-coil-back" d="M-30 31C-30 13 30 13 30 31S-30 49 -30 49S30 67 30 67S-30 85 -30 85S30 103 30 103S-30 121 -30 121" />
      <path className="guide-coil" d="M30 31C30 44 -30 36 -30 49S30 54 30 67S-30 72 -30 85S30 90 30 103S-30 108 -30 121C-30 133 30 125 30 138" />
      <path className="guide-coil-light" d="M30 31C30 44 -30 36 -30 49S30 54 30 67S-30 72 -30 85S30 90 30 103S-30 108 -30 121C-30 133 30 125 30 138" />
      <rect className="guide-spring-seat" x="-43" width="86" height="16" rx="8" />
    </g>
  </g>;
}

function Corner({ over = false, exit = false, mid = false }: { over?: boolean; exit?: boolean; mid?: boolean }) {
  const ideal = mid ? "M100 205C160 65 360 45 475 135" : "M90 205C230 205 310 165 390 65";
  const path = over
    ? mid ? "M100 205C160 65 330 30 360 115" : "M90 205C230 205 325 170 285 75"
    : exit ? "M90 205C230 205 345 165 510 150"
    : mid ? "M100 205C145 25 385 5 515 145" : "M90 205C250 205 390 175 510 120";
  const steeringAngle = over ? 22 : exit ? -14 : mid ? -22 : -28;
  const steering = {
    "--guide-steer-entry": `${over ? -18 : steeringAngle}deg`,
    "--guide-steer-angle": `${steeringAngle}deg`,
    "--guide-steer-exit": `${exit ? 0 : steeringAngle}deg`,
  } as CSSProperties;
  return <g>
    <path className="guide-road-edge" d={ideal} />
    <path className="guide-road" d={ideal} />
    <path className="guide-ideal" d={ideal} />
    <path className="guide-route-shadow" d={path} />
    <path className="guide-actual guide-motion-route" pathLength="1" d={path} />
    <g className="guide-motion-corner" style={{ offsetPath: `path('${path}')`, offsetRotate: "auto", ...steering }}>
      <ellipse className="guide-marker-halo" rx="34" ry="27" />
      <path className="guide-alignment" d="M-25 0H25" />
      <path className="guide-front-axle" d="M0 -17V17" />
      {[-17, 17].map(y => <g key={y} transform={`translate(0 ${y})`}>
        <g className="guide-motion-steer">
          <rect className="guide-steering-tyre" x="-15" y="-7" width="30" height="14" rx="4" />
          <path className="guide-steering-tread" d="M-11 -2H11M-11 2H11" />
          <path className="guide-steering-edge" d="M-11 -6H11" />
        </g>
        <circle className="guide-metal" r="2" />
      </g>)}
      <path className="guide-marker" d="M24 0L16 -5L16 5Z" />
    </g>
    <Label x={300}>{m.lmu_guide_front()}</Label>
  </g>;
}

function AeroFlow({ paths }: { paths: string[] }) {
  return <g>{paths.map((d, index) => <g key={index}>
    <path className="guide-aero-streamline" d={d} />
    <path className="guide-airflow guide-motion-air" style={{ animationDelay: `${index * -0.4}s` }} d={d} />
  </g>)}</g>;
}


function RearWing({ high }: { high: boolean }) {
  return <g>
    <rect className="guide-aero-carbon" x="315" y="199" width="70" height="8" rx="2" />
    <rect className="guide-aero-mount" x="342" y="109" width="12" height="90" rx="2" />
    <g transform={`translate(300 116) rotate(${high ? -16 : -4})`}>
      <path className="guide-aero-blade" d="M-100 0C-108 -10 -80 -16 -45 -12Q25 -6 110 0Q5 36 -60 22Q-100 14 -100 0Z" />
      <path className="guide-aero-blade-edge" d="M-100 0Q-100 14 -60 22Q5 36 110 0" />
      <path className="guide-aero-surface-highlight" d="M-91 -7Q-65 -15 -45 -12Q25 -6 110 0" />
    </g>
    <AeroFlow paths={[
      `M45 68C160 68 225 62 302 64S448 ${high ? 44 : 65} 555 ${high ? 38 : 64}`,
      `M45 97C150 97 175 82 260 88S430 ${high ? 70 : 100} 555 ${high ? 57 : 93}`,
      `M45 124C140 124 170 155 280 157S440 ${high ? 115 : 144} 555 ${high ? 90 : 132}`,
      `M45 157C160 157 210 177 300 178S449 ${high ? 147 : 171} 555 ${high ? 125 : 161}`,
    ]} />
    <Force x={300} y={186} small={!high} />
    <Label x={300}>{m.lmu_guide_rear()}</Label>
  </g>;
}

function FrontSplitter({ high }: { high: boolean }) {
  const lip = high ? 169 : 215;
  return <g>
    <rect className="guide-ground" x="50" y="211" width="500" height="5" rx="2" />
    <rect className="guide-aero-mount" x="354" y="108" width="14" height="64" rx="2" />
    <rect className="guide-aero-carbon" x="342" y="104" width="38" height="7" rx="2" />
    <rect className="guide-aero-pressure" x={lip} y="184" width={450 - lip} height="16" opacity={high ? 0.24 : 0.1} />
    <path className="guide-aero-blade" d={`M${lip} 172H450V180H${lip + 5}Q${lip} 180 ${lip} 172Z`} />
    <path className="guide-aero-blade-edge" d={`M${lip} 172H450`} />
    <path className="guide-aero-splitter-stay" d={`M${lip + 38} 172L354 111`} />
    <circle className="guide-metal" cx={lip + 38} cy="172" r="3" />
    <AeroFlow paths={[
      "M45 118H555",
      `M45 150C125 150 ${lip - 12} 151 ${lip + 20} 158S450 156 555 154`,
      `M45 183C125 183 ${lip - 12} 182 ${lip + 20} 187S450 ${high ? 190 : 188} 555 ${high ? 184 : 187}`,
      "M45 204C160 204 220 203 300 203S455 205 555 204",
    ]} />
    <Force x={lip + 60} y={132} small={!high} />
    <Label x={300}>{m.lmu_guide_front()}</Label>
  </g>;
}

function ToeWheel({ x, y, angle }: { x: number; y: number; angle: number }) {
  return <g transform={`translate(${x} ${y})`}>
    <path className="guide-alignment" d="M0 -45V45" />
    <g transform={`rotate(${angle})`}>
      <rect className="guide-rubber" x="-20" y="-34" width="40" height="68" rx="9" />
      <path className="guide-tread" d="M-10 -29V29M0 -29V29M10 -29V29" />
      <path className="guide-tyre-band" d="M-19 -34H19V-29H-19Z" />
    </g>
  </g>;
}

function DifferentialWheel({ x, outside, high }: { x: number; outside: boolean; high: boolean }) {
  // Rotation over the same conceptual interval; stronger coupling narrows the difference.
  const turn = high ? outside ? 110 : 90 : outside ? 150 : 50;
  const angle = turn * Math.PI / 180;
  return <g transform={`translate(${x} 135)`}>
    <circle className="guide-rubber" r="45" />
    <circle className="guide-hub" r="29" />
    <circle className="guide-metal" r="10" />
    <path className="guide-measurement" d={`M0 -57A57 57 0 0 1 ${57 * Math.sin(angle)} ${-57 * Math.cos(angle)}`} />
    <g className="guide-motion-diff-wheel" style={{ "--guide-wheel-turn": `${turn}deg` } as CSSProperties}>
      <circle r="62" fill="none" />
      <path className="guide-tyre-band" d="M-3 -42H3V-19H-3Z" />
      <path className="guide-force-tail" d="M-5 -62L7 -57L-5 -52Z" />
    </g>
  </g>;
}

function Drawing({ id, high, axle }: { id: string; high: boolean; axle?: "front" | "rear" }) {
  switch (id) {
    case "pressure":
      return <g><Ground /><Tyre x={300} motion="guide-motion-squash" />
        <ellipse className="guide-contact-glow guide-motion-contact" cx="300" cy="212" rx={high ? 32 : 52} ry="8" />
        <rect className="guide-contact guide-motion-contact" x={high ? 269 : 250} y="209" width={high ? 62 : 100} height="7" rx="3" />
        <Force x={300} y={48} />
        <g transform="translate(430 115)">
          <circle className="guide-gauge-shell" r="38" />
          <circle className="guide-gauge-well" r="32" />
          <path className="guide-gauge-arc" d="M-26 12A29 29 0 1 1 26 12" />
          <g transform={`rotate(${high ? 48 : -48})`}><path className="guide-gauge-needle" d="M-3 7L0 -24L3 7Z" /></g>
          <circle className="guide-metal" r="5" />
        </g>
        <Label x={300}>{m.lmu_guide_grip()}</Label></g>;
    case "camber":
      return <g><Ground /><Tyre x={300} tilt={high ? -16 : -4} />
        <ellipse className="guide-contact-glow" cx="300" cy="214" rx="43" ry="7" />
        <path className="guide-alignment" d="M300 50V211" />
        <Force x={300} y={48} /><Force x={435} y={152} rotate={90} /><Label x={300}>{m.lmu_guide_load()}</Label></g>;
    case "toe":
      return <g>
        <ToeWheel x={190} y={78} angle={high ? -14 : -2} /><ToeWheel x={410} y={78} angle={high ? 14 : 2} />
        <ToeWheel x={190} y={188} angle={high ? 14 : 2} /><ToeWheel x={410} y={188} angle={high ? -14 : -2} />
        <Label x={300} y={83}>{m.lmu_guide_front()}</Label><Label x={300} y={193}>{m.lmu_guide_rear()}</Label>
      </g>;
    case "caster": {
      const trail = high ? 292 : 310;
      return <g><Ground />
        <circle className="guide-rubber" cx="330" cy="166" r="45" />
        <circle className="guide-disc-face" cx="330" cy="166" r="29" />
        <circle className="guide-hub" cx="330" cy="166" r="11" />
        <path className="guide-alignment" d="M330 55V214" />
        <path className="guide-steering-axis" d={`M${high ? 365 : 345} 55L${trail} 211`} />
        <circle className="guide-metal" cx={high ? 351 : 338} cy="85" r="8" />
        <path className="guide-measurement" d={`M${trail} 220H330M${trail} 215V225M330 215V225`} />
        <Force x={145} y={145} rotate={90} /><Label x={145}>{m.lmu_guide_front()}</Label>
      </g>;
    }
    case "rearWing":
    case "symptom:fastOver":
      return <RearWing high={high} />;
    case "frontSplitter":
    case "symptom:fastUnder":
      return <FrontSplitter high={high} />;
    case "rideHeight": {
      // Change one axle at a time; the opposite axle remains at the same height.
      const front = axle === "rear" ? 140 : high ? 117 : 160;
      const rear = axle === "rear" ? high ? 117 : 160 : 140;
      return <g><Ground />
        <path className="guide-housing-side" d={`M140 ${front}L460 ${rear}L480 ${rear + 12}L120 ${front + 12}Z`} />
        <path className="guide-accent" d={`M120 ${front + 12}L480 ${rear + 12}V${rear + 17}L120 ${front + 17}Z`} />
        <path className="guide-measurement" d={`M95 ${front + 17}V211M87 ${front + 17}H103M87 211H103M505 ${rear + 17}V211M497 ${rear + 17}H513M497 211H513`} />
        <Label x={180}>{m.lmu_guide_front()}</Label><Label x={420}>{m.lmu_guide_rear()}</Label>
      </g>;
    }
    case "springs":
      return <g><Spring x={300} stiff={high} /><Force x={165} y={110} />
        <Label x={300}>{axle === "front" ? m.lmu_guide_front() : axle === "rear" ? m.lmu_guide_rear() : m.lmu_guide_suspension()}</Label></g>;
    case "antiRollBars":
      return <g><Tyre x={160} motion="guide-motion-lift" /><Tyre x={440} motion="guide-motion-drop" />
        <rect className="guide-housing" x="232" y="107" width="25" height="30" rx="6" />
        <rect className="guide-housing" x="343" y="107" width="25" height="30" rx="6" />
        <g className="guide-motion-roll">
          <path className="guide-coil-back" d="M160 154L185 122H415L440 154" />
          <path className="guide-coil" d="M160 154L185 122H415L440 154" />
        </g>
        <Force x={90} y={130} /><Force x={510} y={170} rotate={180} /><Label x={300}>{m.lmu_guide_load()}</Label></g>;
    case "dampers":
      return <g><g transform="translate(300 45)">
        <ellipse className="guide-object-shadow" cy="181" rx="71" ry="10" />
        <rect className="guide-damper-shell" x="-42" y="55" width="84" height="120" rx="16" />
        <rect className="guide-damper-window" x="-31" y="69" width="62" height="89" rx="9" />
        <rect className="guide-fluid" x="-30" y="113" width="60" height="44" rx="8" />
        <g className={high ? "guide-motion-piston-stiff" : "guide-motion-piston"}>
          <rect className="guide-metal" x="-8" width="16" height="112" rx="5" />
          <rect className="guide-piston" x="-29" y="102" width="58" height="14" rx="5" />
          <path className="guide-fluid-flow" d="M-15 122V140M0 122V148M15 122V140" />
        </g>
        <rect className="guide-spring-seat" x="-53" y="166" width="106" height="14" rx="7" />
      </g><Force x={160} y={120} /><Label x={300}>{m.lmu_guide_suspension()}</Label></g>;
    case "bumpstops":
    case "symptom:bumpUnder":
      return <g><Ground /><rect className="guide-metal" x="290" y="50" width="20" height="145" rx="8" />
        <rect className="guide-warm guide-motion-bumpstop" x="255" y="75" width="90" height="45" rx="16" />
        <rect className="guide-housing guide-motion-stop" x="220" y="163" width="160" height="25" rx="10" />
        <Force x={175} y={155} rotate={180} /><Label x={300}>{m.lmu_guide_load()}</Label></g>;
    case "thirdSpring":
      return <g><Ground /><Tyre x={140} /><Tyre x={460} /><Spring x={300} stiff={high} />
        <rect className="guide-housing" x="160" y="185" width="280" height="16" rx="8" />
        <Force x={140} y={50} small /><Force x={460} y={50} small /><Label x={300}>{m.lmu_guide_suspension()}</Label></g>;
    case "brakeBias":
    case "brakeMigration":
    case "symptom:hybridBrake":
      return <g><Disc x={180} /><Disc x={420} />
        <Force x={85} y={145} rotate={-90} small={!high} /><Force x={515} y={145} rotate={90} small={high} />
        <rect className="guide-track" x="245" y="136" width="110" height="18" rx="9" />
        <circle className={`guide-accent ${id === "brakeBias" ? "" : "guide-motion-balance"}`} cx={high ? 270 : 330} cy="145" r="13" />
        <Label x={180}>{m.lmu_guide_front()}</Label><Label x={420}>{m.lmu_guide_rear()}</Label></g>;
    case "brakePressure":
      return <g><rect className="guide-housing" x="110" y="95" width="60" height="100" rx="14" />
        <rect className="guide-accent guide-motion-pedal" x="120" y="105" width="40" height="70" rx="8" />
        <Force x={250} y={145} rotate={-90} /><Disc x={410} hot /><Label x={300}>{m.lmu_guide_braking()}</Label></g>;
    case "brakeDucts":
      return <g><Disc x={385} hot={!high} />
        <path className="guide-housing-side" d="M88 110L250 122V169L88 182Z" />
        <path className="guide-duct" d={`M80 ${high ? 103 : 122}L245 121V164L80 ${high ? 183 : 164}Z`} />
        {[0, 1, 2].map(i => <path key={i} className="guide-airflow guide-motion-air" style={{ animationDelay: `${i * -0.5}s` }} d={`M60 ${125 + i * 18}H305Q350 ${125 + i * 18} 415 ${95 + i * 50}T525 ${100 + i * 47}`} />)}
        <Label x={180}>{m.lmu_guide_flow()}</Label><Label x={385}>{m.lmu_guide_braking()}</Label></g>;
    case "symptom:coldTyres":
      return <g><Tyre x={190} /><Disc x={405} hot />
        <path className="guide-thermal-transfer guide-motion-air" d="M360 155Q300 100 230 155" />
        <path className="guide-snow" d="M115 72V108M99 81L131 99M99 99L131 81" />
        <Label x={190}>{m.lmu_guide_grip()}</Label><Label x={405}>{m.lmu_guide_braking()}</Label></g>;
    case "diffPreload":
    case "diffPower":
    case "diffCoast":
    case "frontDiff":
    case "symptom:frontDiffEntry": {
      const coast = id === "diffCoast";
      const preload = id === "diffPreload";
      const front = id === "frontDiff" || id === "symptom:frontDiffEntry";
      return <g>
        <rect className="guide-metal" x="135" y="126" width="330" height="18" rx="9" />
        <rect className="guide-housing" x="255" y="95" width="90" height="80" rx="18" />
        {[0, 1, 2, 3].slice(0, high ? 4 : 2).map(i =>
          <path key={i} className="guide-controller-signal" d={`M${275 + i * 12} 111v48`} />)}
        <DifferentialWheel x={135} outside={false} high={high} />
        <DifferentialWheel x={465} outside high={high} />
        {preload
          ? <><Force x={225} y={135} rotate={-90} small /><Force x={375} y={135} rotate={90} small /></>
          : <Force x={300} y={65} rotate={coast ? 180 : 0} small />}
        <Label x={300} y={24}>{preload ? m.lmu_setup_field_diff_preload() : coast ? m.lmu_setup_field_diff_coast() : front ? m.dataguide_torque() : m.lmu_setup_field_diff_power()}</Label>
        <Label x={135} y={215}>{m.lmu_guide_inside_wheel()}</Label>
        <Label x={465} y={215}>{m.lmu_guide_outside_wheel()}</Label>
        <Label x={300}>{front ? m.lmu_guide_front() : m.lmu_guide_rear()}</Label>
      </g>;
    }
    case "electronics":
      return <g><Ground /><Tyre x={180} motion="guide-motion-slip" />
        <g transform="translate(350 98)">
          <rect className="guide-housing-side" x="5" y="5" width="116" height="102" rx="18" />
          <rect className="guide-housing" width="116" height="102" rx="18" />
          <rect className="guide-battery-well" x="12" y="12" width="92" height="78" rx="9" />
          <path className="guide-controller-signal guide-motion-signal" d="M23 53H35L44 32L55 72L66 43L75 53H94" />
          <circle className="guide-accent" cx="93" cy="23" r="3" />
        </g>
        <Force x={270} y={145} rotate={-90} small /><Label x={300}>{m.lmu_guide_grip()}</Label></g>;
    case "symptom:frontLock":
      return <g><Ground /><Tyre x={300} />
        <path className="guide-skid guide-motion-air" d="M275 215V170M325 215V170" />
        <g transform="translate(435 125)"><path className="guide-warm" d="M0 -32L34 27Q36 32 30 32H-30Q-36 32 -34 27Z" />
          <rect className="guide-battery-well" x="-3" y="-11" width="6" height="22" rx="3" /><circle className="guide-battery-well" cy="21" r="3" /></g>
        <Force x={300} y={48} /><Label x={300}>{m.lmu_guide_front()}</Label></g>;
    case "symptom:exitSpin":
      return <g><Ground /><Tyre x={300} motion="guide-motion-slip" />
        <path className="guide-skid guide-motion-air" d="M273 185Q250 205 220 200M327 185Q350 205 380 200" />
        <Force x={300} y={48} /><Label x={300}>{m.lmu_guide_rear()}</Label></g>;
    case "virtualEnergy":
    case "fuelRatio":
    case "symptom:energyShort":
      return <g>
        <g transform="translate(175 143)">
          <ellipse className="guide-object-shadow" cy="71" rx="74" ry="9" />
          <circle className="guide-gauge-shell" r="66" />
          <circle className="guide-gauge-well" r="52" />
          <path className="guide-energy-arc guide-motion-budget" d="M-38 25A46 46 0 1 1 38 25" />
          <text className="guide-gauge-text" textAnchor="middle" y="7">NRG</text>
        </g>
        <g transform="translate(390 78)">
          <ellipse className="guide-object-shadow" cx="47" cy="137" rx="68" ry="9" />
          <rect className="guide-housing-side" x="5" y="4" width="105" height="125" rx="20" />
          <rect className="guide-housing" width="100" height="125" rx="18" />
          <rect className="guide-battery-well" x="10" y="12" width="80" height="102" rx="10" />
          <rect className="guide-fuel guide-motion-drain" x="15" y={high ? 25 : 55} width="70" height={high ? 84 : 54} rx="7" />
          <rect className="guide-metal" x="33" y="-13" width="34" height="20" rx="5" />
          <path className="guide-fuel-symbol" d="M50 42Q27 70 30 78A20 20 0 0 0 70 78Q73 70 50 42Z" />
        </g>
        <Label x={175}>{m.lmu_setup_field_general_virtual_energy()}</Label><Label x={440}>{m.telemetry_fuel()}</Label>
      </g>;
    case "regen":
      return <g><Disc x={160} /><Force x={285} y={145} rotate={-90} /><Battery charge />
        <Label x={160}>{m.lmu_guide_braking()}</Label><Label x={435}>{m.analyse_chart_ers_store()}</Label></g>;
    case "motorMap":
      return <g><Battery x={90} charge={false} /><Force x={290} y={145} rotate={-90} />
        <g transform="translate(430 145)"><circle className="guide-disc-edge" r="57" /><circle className="guide-disc-face" r="50" />
          <g className="guide-motion-spin"><path className="guide-caliper" d="M-12 -32H12L32 -12V12L12 32H-12L-32 12V-12Z" /></g><circle className="guide-hub" r="14" /></g>
        <Label x={150}>{m.analyse_chart_ers_store()}</Label><Label x={430}>{m.lmu_guide_drivetrain()}</Label></g>;
    case "symptom:entryUnder": return <Corner />;
    case "symptom:midUnder": return <Corner mid />;
    case "symptom:entrySnap": return <Corner over />;
    case "symptom:midOver": return <Corner over mid />;
    case "symptom:exitPush": return <Corner exit />;
    case "symptom:kerbLaunch":
      return <g><Ground /><rect className="guide-warm" x="230" y="195" width="140" height="23" rx="8" /><Tyre x={300} motion="guide-motion-bounce" />
        <Force x={420} y={125} rotate={180} /><Label x={300}>{m.lmu_guide_suspension()}</Label></g>;
    case "symptom:hotPressures":
      return <g><Ground /><Tyre x={190} motion="guide-motion-squash" />
        <rect className="guide-housing" x="385" y="70" width="28" height="110" rx="14" /><circle className="guide-housing" cx="399" cy="185" r="28" />
        <rect className="guide-warm guide-motion-temperature" x="393" y="85" width="12" height="100" rx="6" /><circle className="guide-warm" cx="399" cy="185" r="18" />
        <Force x={290} y={145} rotate={-90} small /><Label x={300}>{m.lmu_guide_load()}</Label></g>;
    default: throw new Error(`Missing LMU guide illustration: ${id}`);
  }
}

function Materials({ id }: { id: string }) {
  return <defs>
    <linearGradient id={`${id}-rubber`} className="guide-gradient-rubber" x1="0" x2="1">
      <stop /><stop offset=".28" /><stop offset=".48" /><stop offset="1" />
    </linearGradient>
    <linearGradient id={`${id}-metal`} className="guide-gradient-metal" x1="0" x2="1">
      <stop /><stop offset=".25" /><stop offset=".42" /><stop offset=".7" /><stop offset="1" />
    </linearGradient>
    <linearGradient id={`${id}-housing`} className="guide-gradient-housing" x1="0" y1="0" x2=".7" y2="1">
      <stop /><stop offset=".35" /><stop offset="1" />
    </linearGradient>
    <linearGradient id={`${id}-accent`} className="guide-gradient-accent" x1="0" y1="0" x2=".8" y2="1">
      <stop className="guide-gradient-accent-start" /><stop className="guide-gradient-accent-start" offset=".5" /><stop className="guide-gradient-accent-end" offset="1" />
    </linearGradient>
    <linearGradient id={`${id}-warm`} className="guide-gradient-warm" x1="0" y1="0" x2="1" y2="1">
      <stop /><stop offset=".55" /><stop offset="1" />
    </linearGradient>
    <radialGradient id={`${id}-disc`} className="guide-gradient-disc" cx=".38" cy=".3">
      <stop /><stop offset=".45" /><stop offset=".78" /><stop offset="1" />
    </radialGradient>
    <linearGradient id={`${id}-carbon`} className="guide-gradient-carbon" x1="0" y1="0" x2=".3" y2="1">
      <stop /><stop offset=".25" /><stop offset=".65" /><stop offset="1" />
    </linearGradient>
  </defs>;
}

const DIFFERENTIAL_TOPICS = new Set(["diffPreload", "diffPower", "diffCoast", "frontDiff", "symptom:frontDiffEntry"]);
const COMPARISON_TOPICS = new Set(["pressure", "camber", "toe", "caster", "rearWing", "frontSplitter", "rideHeight", "springs", "dampers", "brakeBias", "brakeDucts", "diffPreload", "diffPower", "diffCoast", "frontDiff"]);
const AXLE_PARAMETERS: Record<string, readonly [string, string]> = {
  rideHeight: ["rideHeightF", "rideHeightR"],
};

export function LmuGuideIllustration({ parameterId, title, description }: { parameterId: string; title: string; description: string }) {
  const id = useId();
  const [paused, setPaused] = useState(false);
  const parameters = getLmuGuideContent().parameters;
  const comparisonIds = COMPARISON_TOPICS.has(parameterId) ? AXLE_PARAMETERS[parameterId] ?? [parameterId === "springs" ? "springF" : parameterId] : [];
  const comparisons = comparisonIds.flatMap(id => {
    const parameter = parameters.find(item => item.id === id);
    return parameter ? [parameter] : [];
  });
  const panels = comparisons.length
    ? comparisons.flatMap((parameter, index) => [false, true].map(high => ({
        parameter, high, axle: AXLE_PARAMETERS[parameterId] ? index === 0 ? "front" as const : "rear" as const : undefined,
      })))
    : [{ parameter: undefined, high: false, axle: undefined }];
  return <div className="lmu-guide-illustration" data-paused={paused}>
    <div className={comparisons.length ? "guide-comparison-grid" : undefined}>
      {panels.map(({ parameter, high, axle }) => {
        const panelId = `${id}-${axle ?? "all"}-${high ? "high" : "low"}`;
        const effect = parameter ? (high ? parameter.up : parameter.down).effects[0] : description;
        const settingLabel = parameter ? high ? parameter.upLabel : parameter.downLabel : title;
        const paints = {
          "--guide-rubber-paint": `url(#${panelId}-rubber)`,
          "--guide-metal-paint": `url(#${panelId}-metal)`,
          "--guide-housing-paint": `url(#${panelId}-housing)`,
          "--guide-accent-paint": `url(#${panelId}-accent)`,
          "--guide-warm-paint": `url(#${panelId}-warm)`,
          "--guide-disc-paint": `url(#${panelId}-disc)`,
          "--guide-carbon-paint": `url(#${panelId}-carbon)`,
        } as CSSProperties;
        return <figure key={panelId} className="guide-comparison-panel" data-setting={high ? "high" : "low"} style={paints}>
          {parameter && <h3 className="guide-setting-title">{axle && <>{axle === "front" ? m.lmu_guide_front() : m.lmu_guide_rear()} · </>}{settingLabel}</h3>}
          <div className="guide-stage">
            <svg role="img" aria-labelledby={`${panelId}-title ${panelId}-description`} data-guide-illustration={parameterId} viewBox="0 0 600 280" className="guide-svg">
              <title id={`${panelId}-title`}>{axle ? parameter?.name : title} · {settingLabel}</title><desc id={`${panelId}-description`}>{description} {parameter ? effect : ""} {DIFFERENTIAL_TOPICS.has(parameterId) ? m.lmu_guide_diff_coupling() : ""}</desc>
              <Materials id={panelId} />
              <Drawing id={parameterId} high={high} axle={axle} />
            </svg>
            {["symptom:entryUnder", "symptom:entrySnap", "symptom:midUnder", "symptom:midOver", "symptom:exitPush"].includes(parameterId) &&
              <div className="guide-legend">
                <span><i className="guide-legend-ideal" aria-hidden="true" />{m.track_map_racing_line()}</span>
                <span><i className="guide-legend-actual" aria-hidden="true" />{title}</span>
              </div>}
          </div>
          {parameterId !== "springs" && <figcaption className="guide-caption">
            <div className="guide-takeaway">
              <span className="guide-takeaway-mark" aria-hidden="true" />
              <p className="guide-explanation">{effect}</p>
            </div>
            {DIFFERENTIAL_TOPICS.has(parameterId) && <p className="guide-explanation mb-4">{m.lmu_guide_diff_coupling()}</p>}
          </figcaption>}
        </figure>;
      })}
    </div>
    <div className="guide-caption-footer text-app-subtext text-app-text-muted"><span>{m.lmu_guide_diagram_caption()}</span>
      <Button className="lmu-guide-motion-toggle text-app-subtext" variant="app-ghost" size="app-sm" aria-pressed={paused} onClick={() => setPaused(!paused)}>
        {paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}{paused ? m.common_resume() : m.common_pause()}
      </Button>
    </div>
  </div>;
}
