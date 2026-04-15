/**
 * Expert track guides providing corner-by-corner racing knowledge.
 *
 * This module enriches AI analysis with track-specific context that cannot be
 * derived from telemetry alone: corner characteristics, ideal techniques,
 * common traps, and priority corners for lap time.
 *
 * Sources: Driver61, Coach Dave Academy, DIY Sim Studio, Track Titan
 */

interface CornerGuide {
  /** Corner name — should match segment names in track meta where possible */
  name: string;
  /** Corner classification */
  type: string;
  /** Key technique in imperative form */
  technique: string;
  /** Common mistake / trap */
  trap: string;
}

interface TrackGuide {
  /** Matches track meta filename (e.g., "spa", "monza") */
  id: string;
  /** Track character in one line */
  character: string;
  /** Per-corner expert knowledge */
  corners: CornerGuide[];
  /** Corner names most critical for lap time (exit speed → long straight, or high-speed commitment) */
  priorityCorners: string[];
}

const guides: TrackGuide[] = [
  // ─── Spa-Francorchamps ───
  {
    id: "spa",
    character: "High-speed, 7km flowing circuit with huge elevation changes and unpredictable weather. Rewards bravery, smooth inputs, and good exits onto long straights.",
    corners: [
      { name: "La Source", type: "tight hairpin", technique: "Brake hard 100m before, late apex, smooth throttle on exit — exit speed feeds Eau Rouge", trap: "Early apex causes wheelspin on exit, ruining Kemmel Straight speed" },
      { name: "Eau Rouge", type: "high-speed left-right-left with elevation", technique: "Approach flat-out or with minor lift, minimal steering input, let the car flow up the hill", trap: "Too much steering input unsettles the car; lifting too much costs massive straight speed" },
      { name: "Raidillon", type: "blind high-speed crest", technique: "Aim for inside kerb at crest, keep car balanced as it goes light over the top", trap: "Running wide over the crest onto exit kerb — high crash risk" },
      { name: "Les Combes", type: "medium-speed right-left-right chicane", technique: "Brake 120m before T5, hard straight-line braking, smooth transitions through the chicane", trap: "Excessive kerb usage on T6 causes instability and poor exit onto Malmedy straight" },
      { name: "Malmedy", type: "fast right-hander", technique: "Trail brake to late apex, use full track width on exit", trap: "Early turn-in leads to running wide and slow exit" },
      { name: "Rivage", type: "downhill hairpin", technique: "Late apex, patient throttle — exit leads into fast section", trap: "Braking too late on the downhill approach, missing the apex" },
      { name: "Pouhon", type: "double-apex high-speed left", technique: "Commit to the entry, carry speed through both apexes with smooth steering", trap: "Lifting mid-corner kills momentum through an entire sector" },
      { name: "Fagnes", type: "fast chicane", technique: "Light braking, smooth direction changes, use kerbs carefully", trap: "Over-driving causes snap oversteer on direction change" },
      { name: "Stavelot", type: "double-apex right", technique: "Late first apex, short straight, then commit to second part — exit speed is critical", trap: "Too much speed into first part compromises second apex and exit onto Blanchimont approach" },
      { name: "Blanchimont", type: "very fast left kink", technique: "Flat in most cars, tiny lift if needed — smooth steering only", trap: "Any snap correction at 250+ km/h risks losing the car" },
      { name: "Bus Stop", type: "tight right-left chicane", technique: "Brake 130m before, hard and late. Clean exit feeds start/finish straight", trap: "Over-committing on entry; poor exit loses time all down the pit straight" },
    ],
    priorityCorners: ["La Source", "Eau Rouge", "Pouhon", "Stavelot", "Bus Stop"],
  },

  // ─── Silverstone ───
  {
    id: "silverstone",
    character: "Fast, flowing 5.9km circuit that rewards rhythm and momentum. High-speed corners dominate — Maggotts-Becketts is one of the best sequences in racing. Few heavy braking zones means every tenth counts in the fast stuff.",
    corners: [
      { name: "Abbey", type: "fast right-hander", technique: "Lift or light brake, smooth turn-in, use bump on apex as reference", trap: "Using too much exit road compromises Farm entry" },
      { name: "Farm", type: "fast left-hander", technique: "Flat or near-flat, smooth inputs, three red kerbs mark apex", trap: "Sudden lift-off causes lift-off oversteer at high speed" },
      { name: "Village", type: "medium-speed right", technique: "First real braking zone — hard braking, late apex for good exit into The Loop", trap: "Early apex leads to running wide and slow Loop entry" },
      { name: "The Loop", type: "slow hairpin (slowest corner)", technique: "Patient entry, late apex, progressive throttle — exit onto Wellington Straight is critical", trap: "Early throttle causes wheelspin; poor exit loses time on the entire straight" },
      { name: "Aintree", type: "medium-speed sweeper", technique: "Carry momentum from Loop exit, late apex", trap: "Over-slowing kills Wellington Straight speed" },
      { name: "Brooklands", type: "slow left-hander", technique: "Hard braking, late apex, clean exit for Luffield", trap: "Braking too deep and missing the apex" },
      { name: "Luffield", type: "long slow left-hander", technique: "Double apex: hit early apex, drift out, tighten for second apex. Exit speed onto Wellington is huge", trap: "Single apex line loses exit speed onto the long straight" },
      { name: "Copse", type: "very fast right-hander", technique: "Requires commitment — flat or tiny lift, smooth steering, trust the grip", trap: "Hesitation mid-corner scrubs massive speed" },
      { name: "Maggotts", type: "fast left (part of Maggotts-Becketts)", technique: "Quick flick left, clip apex, immediately prepare for right", trap: "Over-driving any part of this sequence ruins the whole complex" },
      { name: "Becketts", type: "fast right-left (part of complex)", technique: "Flow through with smooth, quick direction changes — carry as much speed as possible", trap: "Fighting the car with big steering corrections; need rhythm and commitment" },
      { name: "Chapel", type: "fast right onto Hangar Straight", technique: "Exit speed is everything — feeds the longest straight on the circuit", trap: "Getting greedy through Becketts and arriving at Chapel offline" },
      { name: "Stowe", type: "fast right-hander", technique: "Brake in a straight line, hit the apex, use exit kerb", trap: "Braking too late on the downhill approach" },
      { name: "Vale", type: "medium-speed left", technique: "Multiple braking references (gantry, turn-in board, entry kerb). Good exit sets up Club", trap: "Bumpy braking zone causes lockups" },
      { name: "Club", type: "fast right (final corner)", technique: "Flat in most cars — exit from Vale is critical, long vision through the corner", trap: "Poor Vale exit means slow Club and slow pit straight speed" },
    ],
    priorityCorners: ["The Loop", "Copse", "Becketts", "Chapel", "Club"],
  },

  // ─── Monza ───
  {
    id: "monza",
    character: "The Temple of Speed — 5.8km low-downforce circuit with long straights and heavy braking chicanes. Top speed and braking stability are everything. Exit speed from slow corners feeds massive straights.",
    corners: [
      { name: "Variante del Rettifilo", type: "tight right-left chicane (T1-T2)", technique: "Brake between 150m and 100m board, trail brake to late apex in T1, smooth transition to T2. Hug flat inside kerb, avoid sausage kerbs", trap: "Braking too late and cutting the chicane; early T1 apex kills T2 exit speed" },
      { name: "Curva Grande", type: "long fast right sweeper", technique: "Flat-out in most cars, use full track width, smooth steering", trap: "Any correction at this speed scrubs massive time" },
      { name: "Variante della Roggia", type: "left-right chicane (T4-T5)", technique: "Hard braking from high speed, aggressive downshifts, use astroturf reference for turn-in", trap: "Bouncing over sausage kerbs destabilises the car for Lesmo approach" },
      { name: "Lesmo 1", type: "medium-fast right-hander", technique: "Keep left, brake later than you think. Use orange barrier as braking ref. Trail brake with 20% pressure into the turn", trap: "Excessive caution here — it's faster than it looks. Running wide kills Lesmo 2 entry" },
      { name: "Lesmo 2", type: "medium-speed right (tighter than Lesmo 1)", technique: "Brake at 50m board, mid-to-late apex. Clean exit is critical — feeds long straight to Ascari", trap: "Too tight an apex loses exit speed; use all exit kerbing and astroturf" },
      { name: "Ascari", type: "left-right-left chicane (T8-T9-T10)", technique: "Brake late but maintain control through the sequence, smooth direction changes", trap: "Over-driving the entry compromises the final exit onto the straight to Parabolica" },
      { name: "Parabolica", type: "long tightening right-hander", technique: "Brake at 100m board, late apex, progressive throttle. Exit speed feeds the longest straight", trap: "Early apex = early throttle = massive oversteer on exit. Patience is everything here" },
    ],
    priorityCorners: ["Variante del Rettifilo", "Lesmo 2", "Parabolica"],
  },

  // ─── Suzuka ───
  {
    id: "suzuka",
    character: "Unique figure-eight layout, 5.8km. Mix of flowing high-speed sections and technical slow corners. The Esses are the signature — rhythm and commitment define fast laps. Demands a balanced car setup.",
    corners: [
      { name: "First Curve", type: "fast right-hander (T1)", technique: "Light braking or lift, smooth turn-in at 210-230 km/h. Position well for Second Curve", trap: "Over-slowing loses momentum through the opening sequence" },
      { name: "Second Curve", type: "medium-speed left (T2)", technique: "Brake firmly, hit a late apex to open up the entry to the Esses", trap: "Early apex compromises the critical S-Curves entry" },
      { name: "S Curves", type: "fast flowing left-right-left-right-left sequence (T3-T7)", technique: "Rhythm is everything — light braking or lifts between direction changes, carry maximum speed, trust the car", trap: "Over-driving any single apex ruins the whole sequence. Smooth > aggressive here" },
      { name: "Dunlop Curve", type: "medium-speed right (T8)", technique: "Moderate braking, late apex, good exit feeds Degner approach", trap: "Flat-spotting tires under heavy braking on the downhill" },
      { name: "Degner 1", type: "fast right-hander (T9)", technique: "Quick direction change from Dunlop exit, commit to the speed, clip apex", trap: "Hesitation loses huge time; need trust in the car's grip" },
      { name: "Degner 2", type: "tight right (T10)", technique: "Hard braking, late apex. Exit feeds the straight to the Hairpin", trap: "Carrying too much speed from Degner 1 and over-shooting" },
      { name: "Hairpin", type: "slow hairpin (T11, slowest corner)", technique: "Hard braking, tricky because you're turning while braking. Late apex, patience on throttle", trap: "Braking straight is difficult due to approach angle; locking inside front tire" },
      { name: "Spoon Curve", type: "double-apex left (T13-T14)", technique: "Late braking into first apex, coast briefly, then smooth throttle for second apex. Exit speed feeds back straight + 130R", trap: "Too much speed into first part ruins second apex; poor exit speed loses time through 130R and down the straight" },
      { name: "130R", type: "very fast left-hander (T15)", technique: "Flat-out in most cars at ~300 km/h. Minimal steering input, trust the aero", trap: "Any lift or correction at this speed is enormously costly" },
      { name: "Casio Triangle", type: "tight chicane (T16-T18)", technique: "Hard braking from 130R speed, precise through the chicane, clean exit onto start/finish straight", trap: "Braking too late after 130R commitment; losing exit speed onto the main straight" },
    ],
    priorityCorners: ["S Curves", "Spoon Curve", "130R", "Casio Triangle"],
  },

  // ─── Imola ───
  {
    id: "imola",
    character: "Historic 4.9km circuit, narrow and technical with limited overtaking. Undulating, flowing, and punishing mistakes with little runoff. Precision and curb management are key.",
    corners: [
      { name: "Variante Tamburello", type: "medium-speed left-right chicane (T2-T4)", technique: "Brake from 6th to 2nd gear, late apex T2, use sausage kerbs carefully. T4 kink should be flat with correct line", trap: "Running wide out of the chicane makes T4 impossible to take flat" },
      { name: "Villeneuve", type: "left-right chicane (T5-T6)", technique: "Hard braking, precise through both apexes. Use inside kerbs but avoid sausages", trap: "Too aggressive over kerbs triggers TC intervention and snap oversteer" },
      { name: "Tosa", type: "slow left hairpin (T7)", technique: "Brake after 50m board, 2nd gear, mid-to-late apex. Trail brake heavily, get on power early as exit opens", trap: "Early apex prevents early throttle application" },
      { name: "Piratella", type: "fast uphill right (T9)", technique: "Near-flat or light braking, use the elevation to your advantage. Commitment rewarded", trap: "Lifting kills momentum through the fast section that follows" },
      { name: "Acque Minerali", type: "technical right-right-left sequence (T10-T13)", technique: "Brake at 50m board for T11, 3rd gear, clip inside. Quick throttle blip between apexes to settle car, then commit to T12-T13", trap: "Aggressive turn-in while braking causes rear rotation; need smooth weight transfer" },
      { name: "Variante Alta", type: "left-right chicane (T14-T15)", technique: "Hard braking, carry speed to late apex. Critical exit feeds Rivazza approach", trap: "Compromising exit speed by over-driving the entry" },
      { name: "Rivazza 1", type: "fast downhill left (T17)", technique: "Brave entry, trail brake to apex, use camber for grip", trap: "Braking too early wastes the downhill advantage" },
      { name: "Rivazza 2", type: "medium-speed left (T18)", technique: "Late apex, progressive throttle. Exit speed feeds start/finish straight", trap: "Early apex = wheelspin on exit = slow pit straight" },
    ],
    priorityCorners: ["Tosa", "Acque Minerali", "Rivazza 2"],
  },

  // ─── Barcelona-Catalunya ───
  {
    id: "catalunya",
    character: "Technical 4.7km circuit used for F1 testing — demands a well-balanced car. Mix of high-speed sweeps and slow technical corners. Tire degradation is a key factor due to high-energy corners.",
    corners: [
      { name: "Turn 1", type: "medium-speed right (Elf)", technique: "Brake just before 100m board, 2nd gear, mid-to-late apex. Part of T1-T3 complex", trap: "Getting on the kerb too aggressively into the right-left sequence" },
      { name: "Turn 3", type: "fast right-hander", technique: "Carry momentum from T1-T2, smooth exit leads to T4", trap: "Over-driving T1 entry compromises the entire opening complex" },
      { name: "Turn 4", type: "medium-speed right (Repsol)", technique: "Early apex and slowest point, speed reduction early in the corner", trap: "Going deep into T4 ruins T5 exit onto the long straight" },
      { name: "Turn 5", type: "slow left-right (Seat chicane)", technique: "Clean exit is everything — feeds the longest straight. Sacrifice T4 speed for T5 exit", trap: "Carrying too much speed into T5 and running wide on exit" },
      { name: "Turn 7", type: "uphill left-right chicane", technique: "Brake at entry kerb, 2nd gear. Use camber for grip, smooth through direction change. Early power for T8-T9", trap: "Snap oversteer on throttle application at T7 apex" },
      { name: "Turn 9", type: "fast right onto back straight", technique: "Critical corner — exit speed feeds the back straight. Late apex, progressive throttle", trap: "Compromising T9 exit by over-driving T7-T8" },
      { name: "Turn 10", type: "medium-speed right (La Caixa)", technique: "Brake after 100m board, 3rd gear. Turn in under the shadow of the hoarding, miss yellow inside kerbs", trap: "Locking up on the downhill approach" },
      { name: "Turn 12-13", type: "right into left-right chicane", technique: "Compromise T12 speed for good T13 entry. Slowest point before T13 entry. Stay tight through T13 to open T14", trap: "Going deep into T12 destroys the chicane sequence and exit" },
      { name: "Turn 14-15", type: "fast left-right onto straight", technique: "T15 is flat — exit speed from T14 feeds start/finish straight", trap: "Poor chicane exit means slow final sector and pit straight" },
    ],
    priorityCorners: ["Turn 5", "Turn 9", "Turn 14-15"],
  },

  // ─── Brands Hatch GP ───
  {
    id: "brands-hatch",
    character: "Compact 3.9km British circuit with dramatic elevation changes, blind crests, and the iconic Paddock Hill Bend. Natural amphitheatre setting. Technical and flowing, demanding precision on bumpy surfaces.",
    corners: [
      { name: "Paddock Hill Bend", type: "fast downhill right (T1)", technique: "Brake after the 'two' board while slightly turning in. Blind apex — the corner drops away steeply. Late apex, let car drift to exit", trap: "Braking too late into the blind downhill; understeer into the gravel" },
      { name: "Druids", type: "slow uphill hairpin (T2)", technique: "Hard braking uphill, 1st or 2nd gear. Late apex, progressive throttle on exit", trap: "Locking fronts on the uphill approach; early apex kills exit speed down Graham Hill" },
      { name: "Graham Hill Bend", type: "medium-speed downhill left (T3)", technique: "Brake before outside kerbing starts, 2nd gear, mid-point apex. Don't cut inside kerb (causes TC/spin)", trap: "Too much inside kerb causes instability on the bumpy downhill" },
      { name: "Surtees", type: "uphill off-camber left (T4)", technique: "Tricky off-camber corner — brake at the 'one' board, trail brake in. Good exit feeds long straight to Hawthorn", trap: "Off-camber catches out — understeer on entry is common; need good car rotation" },
      { name: "Hawthorn Bend", type: "fastest corner on circuit (T5)", technique: "Brake before 'one' board, 3rd-4th gear, trail brake to inside kerb. Turn in early, hug inside, get on throttle ASAP", trap: "Not committing to the speed — hesitation here costs hugely" },
      { name: "Westfield Bend", type: "medium-fast right (T6)", technique: "Brake at 'one' board, 3rd gear, trail brake in. Cut inside kerb, use all exit kerb and matting", trap: "Not using enough kerb — track limits are lenient here, exploit them" },
      { name: "Sheene Curve", type: "fast right-left (T7-T8)", technique: "Smooth direction changes at speed, carry momentum through both parts", trap: "Over-driving causes snap on direction change" },
      { name: "Clark Curve", type: "fast left leading to Paddock Hill (T9)", technique: "Clean exit onto start/finish straight — exit speed is critical", trap: "Running wide loses speed all the way down the pit straight" },
    ],
    priorityCorners: ["Paddock Hill Bend", "Surtees", "Hawthorn Bend", "Clark Curve"],
  },

  // ─── Nürburgring GP ───
  {
    id: "nurburgring",
    character: "5.1km circuit in the Eifel Mountains. Technical first sector (Mercedes Arena), fast cascading second sector, and chicane-hairpin finale. Demands precision in slow sections and commitment in fast ones.",
    corners: [
      { name: "Castrol-S", type: "sharp downhill right hairpin (T1)", technique: "Brake at 100m board or start of red-white kerbing. 1st gear, late apex, use all exit road", trap: "Misjudging braking on the downhill — easy to over-shoot" },
      { name: "Mercedes Arena", type: "technical left-left-right sequence (T2-T4)", technique: "T2: dab brake at grey kerbing ref, 2nd gear. Stick to inside through T3 as it tightens. T4: flick in early, short-shift to 2nd", trap: "T3 keeps tightening — running wide here ruins T4 exit onto the straight" },
      { name: "Turn 5-6", type: "right-left chicane", technique: "Smooth direction changes, use inside kerbs. Good exit feeds Dunlop Kehre approach", trap: "Over-driving compromises approach to the hairpin" },
      { name: "Dunlop Kehre", type: "downhill right hairpin (T7)", technique: "Tricky braking — no clear reference point. Trail brake to early first apex, coast, then get on power for second apex", trap: "Misjudging the downhill braking zone; no reference markers make this consistently tricky" },
      { name: "Schumacher S", type: "fast left-right (T8-T9)", technique: "High-speed commitment, smooth direction change. Carry speed through both parts", trap: "Fighting the car with corrections instead of flowing through" },
      { name: "Turn 10-11", type: "medium-speed right-left sequence", technique: "Good exit from T11 feeds Bit-Kurve and the fast section", trap: "Over-driving T10 compromises T11 exit" },
      { name: "Bit-Kurve", type: "fast right (T12)", technique: "Flat-out right-hand kink, stay smooth", trap: "Unnecessary lifting" },
      { name: "Veedol", type: "fast left-right chicane (T13-T14)", technique: "Brake between 100m and 50m, 3rd gear. Cut inside kerb T13, smash inside kerb T14 (if ride height allows)", trap: "Hitting concrete block on T13 kerb unsettles the car" },
      { name: "NGK Chicane", type: "final right hairpin (T15)", technique: "Hard braking, tight hairpin. Clean exit onto start/finish straight", trap: "Braking too late and missing the apex; poor exit costs pit straight speed" },
    ],
    priorityCorners: ["Castrol-S", "Dunlop Kehre", "Veedol", "NGK Chicane"],
  },

  // ─── Laguna Seca ───
  {
    id: "laguna-seca",
    character: "Compact 3.6km California circuit famous for the Corkscrew — a blind, steep-drop chicane. 55m elevation change. Technical, with few straight-line braking zones. Rewards smooth, committed driving.",
    corners: [
      { name: "Andretti Hairpin", type: "double-apex left hairpin (T1-T2)", technique: "Brake 150m before T2, straight line through T1 kink. Hit early first apex, drift out, tighten for second apex. Smooth throttle exit", trap: "Single apex approach loses exit speed onto the straight" },
      { name: "Turn 3", type: "medium-speed right", technique: "Brake 70m before, late apex for good exit speed", trap: "Early apex and slow exit" },
      { name: "Turn 4", type: "fast left sweeper", technique: "Near-flat or light braking, commit to the speed, use full track width", trap: "Lifting mid-corner kills momentum" },
      { name: "Turn 5", type: "medium-speed right (uphill)", technique: "Trail brake into late apex, use the elevation change to help rotation", trap: "Under-rotating on the uphill and running wide" },
      { name: "Turn 6", type: "fast blind left with elevation change", technique: "Brake 50m before, commit to turn-in point. Use inside kerb to help rotation, early throttle up the Rahal Straight", trap: "Blind entry makes this scary — hesitation costs time up the straight" },
      { name: "Corkscrew", type: "blind left-right with 18m drop (T8-T8A)", technique: "Brake ~100m before T7, hard and straight. Turn left, then as you crest the hill, flick right and drop. Commit on memory and feel — you can't see the apex", trap: "Everything about this corner is a trap — blind entry, massive elevation drop, left-right transition. Over-braking is most common; under-committing to the blind flick wastes time" },
      { name: "Rainey Curve", type: "fast left sweeper (T9)", technique: "Carry speed from Corkscrew exit, smooth steering, use full track width on exit", trap: "Still recovering from Corkscrew and not committing to this fast corner" },
      { name: "Turn 10", type: "medium-speed right", technique: "Trail brake to late apex, good exit feeds T11 approach", trap: "Early apex compromises final corner entry" },
      { name: "Turn 11", type: "tight left hairpin (final corner)", technique: "Brake 90m before, hard and late. Smooth exit — feeds the start/finish straight. Most important corner for lap time", trap: "Lock-up on entry; early apex causes wheelspin on exit" },
    ],
    priorityCorners: ["Andretti Hairpin", "Turn 6", "Corkscrew", "Turn 11"],
  },

  // ─── Zandvoort ───
  {
    id: "zandvoort",
    character: "Fast, flowing 4.3km Dutch circuit with banked corners (especially the final turn). High-downforce track — rhythm and commitment through the fast middle sector are key. Tricky braking zones with poor visual references.",
    corners: [
      { name: "Tarzan", type: "medium-speed right hairpin (T1)", technique: "Brake at 75m mark (look for brown grass patch), hard braking to 3rd gear. Trail brake to apex", trap: "Multiple racing lines make this deceptive; easy to over-drive on cold tires" },
      { name: "Turn 2-3", type: "fast right into medium-speed right", technique: "T2 fast right-hander — lift off as left kerb disappears. T3: 50% brake to avoid left front lockup, 3rd gear. Early apex, run wide through middle, straighten early for throttle", trap: "Getting greedy at T2 entry makes T3 very tight; T3 left front lockup is common" },
      { name: "Turn 4-6", type: "fast flowing section", technique: "Full throttle through the sequence if car is set up correctly. Smooth steering inputs", trap: "Running over the T3 exit kerb destabilises the car for this section" },
      { name: "Turn 7", type: "medium-speed left-right chicane", technique: "Hard braking, precise through the direction change", trap: "The exit kerbs are deceptive and can launch the car" },
      { name: "Turn 8", type: "tricky medium-speed right", technique: "Very difficult to judge turn-in point. Trust your reference and commit", trap: "One of the trickiest corners on the calendar — misjudging turn-in is near-universal" },
      { name: "Turn 9", type: "slow left-right", technique: "Hard braking, patience through the sequence. Exit feeds a short straight", trap: "Over-driving the first part compromises exit" },
      { name: "Turn 11", type: "tight right hairpin (Arie Luyendyk)", technique: "Hard braking, very late apex. Exit speed feeds the approach to the banked final turns", trap: "Early apex kills the run through the final sector" },
      { name: "Turn 13-14", type: "banked final turns", technique: "T13 brake at ~45m, 4th gear 200 km/h. Avoid inside kerb. T14 follow the banking, full throttle", trap: "Touching T13 inside kerb affects the run; getting too high on T13 exit kerb" },
    ],
    priorityCorners: ["Tarzan", "Turn 8", "Turn 11", "Turn 13-14"],
  },

  // ─── Mount Panorama (Bathurst) ───
  {
    id: "mount-panorama",
    character: "Legendary 6.2km Australian circuit with 174m elevation change. Part public road, part purpose-built. The Mountain section is narrow and unforgiving with concrete walls. Conrod Straight allows 300+ km/h before heavy braking. Demands bravery on the Mountain and precision everywhere.",
    corners: [
      { name: "Hell Corner", type: "tight right at circuit start", technique: "Hard braking, late apex. Exit speed starts the Mountain climb", trap: "Over-cooking entry and running wide — narrow exit" },
      { name: "Mountain Straight", type: "steep uphill straight", technique: "Full throttle up the steep climb, prepare for Griffins Bend", trap: "Not anticipating the crest and gradient changes" },
      { name: "Griffins Bend", type: "fast left over crest", technique: "Commitment over the blind crest, trust the racing line", trap: "Lifting over the crest kills momentum" },
      { name: "The Cutting", type: "fast section through narrow walls", technique: "Precision is critical — concrete walls on both sides. Smooth, committed driving", trap: "Any correction near the walls risks contact" },
      { name: "Reid Park", type: "tight left-right complex", technique: "Hard braking, precise through the direction changes. Walls are very close", trap: "Over-driving into the first part with walls millimeters away" },
      { name: "Skyline", type: "crest at the top of the Mountain", technique: "Car goes light over the top — smooth inputs, let it settle", trap: "Aggressive steering when the car is light = instant snap" },
      { name: "The Esses", type: "fast downhill left-right-left sequence", technique: "Descending quickly with walls close. Rhythm and commitment, carry speed", trap: "Over-driving while descending — the gradient increases speed rapidly" },
      { name: "The Dipper", type: "fast compression into left", technique: "Car loads up in the dip — use the grip from compression", trap: "Not using the compression advantage" },
      { name: "Forrest Elbow", type: "tight left leading to Conrod", technique: "Late apex is critical — feeds the enormously fast Conrod Straight", trap: "Early apex = slow Conrod Straight = massive time loss" },
      { name: "Conrod Straight", type: "very fast downhill straight", technique: "Full throttle, 300+ km/h. Prepare braking for The Chase", trap: "Not preparing early enough for the braking zone at The Chase" },
      { name: "The Chase", type: "left-right chicane after Conrod", technique: "Enormous braking zone from 300+ km/h. Hard, straight-line braking, precise through chicane", trap: "Braking too late from the extremely high speeds; ABS fade" },
      { name: "Murray's Corner", type: "final right-hander", technique: "Late apex, progressive throttle. Exit speed feeds start/finish straight", trap: "Over-committing on entry and losing exit drive" },
    ],
    priorityCorners: ["Forrest Elbow", "The Chase", "Murray's Corner", "The Esses"],
  },
];

// ─── Lookup logic ───

/** Normalise a display name for fuzzy matching */
function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/[''`]/g, "")
    .replace(/[-–—_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Keywords that map a display track name to a guide ID.
 * Order matters — first match wins. More specific patterns go first.
 */
const TRACK_KEYWORDS: [string[], string][] = [
  [["mount panorama", "bathurst"], "mount-panorama"],
  [["brands hatch"], "brands-hatch"],
  [["laguna seca", "weathertech"], "laguna-seca"],
  [["nürburgring", "nurburgring", "nuerburgring"], "nurburgring"],
  [["spa", "francorchamps"], "spa"],
  [["silverstone"], "silverstone"],
  [["monza"], "monza"],
  [["suzuka"], "suzuka"],
  [["imola", "enzo e dino"], "imola"],
  [["barcelona", "catalunya", "catalonia", "montmeló", "montmelo"], "catalunya"],
  [["zandvoort"], "zandvoort"],
];

/** Look up a guide by track meta ID (e.g., "spa") or display name */
function findGuide(trackNameOrId: string): TrackGuide | null {
  const norm = normalise(trackNameOrId);

  // Direct ID match first
  const direct = guides.find((g) => g.id === norm || g.id === trackNameOrId);
  if (direct) return direct;

  // Keyword search against display name
  for (const [keywords, id] of TRACK_KEYWORDS) {
    if (keywords.some((kw) => norm.includes(kw))) {
      return guides.find((g) => g.id === id) ?? null;
    }
  }

  return null;
}

/**
 * Build a formatted track guide context block for AI prompts.
 * Returns empty string if no guide is available for the given track.
 */
export function buildTrackGuideContext(trackName: string): string {
  const guide = findGuide(trackName);
  if (!guide) return "";

  let out = "\n--- Expert Track Guide ---\n";
  out += `${guide.character}\n\n`;
  out += "Corner-by-corner knowledge (use this to assess whether the driver is using correct technique):\n";

  for (const c of guide.corners) {
    out += `• ${c.name} [${c.type}]: ${c.technique}. TRAP: ${c.trap}\n`;
  }

  out += `\nPriority corners (most impactful on lap time): ${guide.priorityCorners.join(", ")}\n`;
  out += "Use this track knowledge to give context-aware coaching. If telemetry shows issues at a priority corner, weight it higher in your analysis.\n";

  return out;
}

/**
 * Returns the list of track IDs that have guides available.
 * Useful for UI indicators showing which tracks have expert knowledge.
 */
export function getAvailableTrackGuides(): string[] {
  return guides.map((g) => g.id);
}
