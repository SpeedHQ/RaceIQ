/**
 * Expert track guides providing corner-by-corner racing knowledge.
 *
 * This module enriches AI analysis with track-specific context that cannot be
 * derived from telemetry alone: corner characteristics, ideal techniques,
 * common traps, and priority corners for lap time.
 *
 * Sources: Driver61, Coach Dave Academy, DIY Sim Studio, Track Titan, official F1 circuit
 * guides, Wikipedia (corner naming cross-reference). Where a corner's official/common name
 * could not be independently verified, entries use generic "Turn N" labels rather than
 * inventing a name — see individual guide comments for tracks with layout-verification caveats
 * (e.g. Singapore, Las Vegas, Lusail).
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
  // Sources: https://www.formula1.com/en/latest/article/circuit-guide-everything-you-need-to-know-about-spa-francorchamps circuit character/corners; long-established F1 circuit knowledge
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
  // Sources: https://www.formula1.com/en/racing/2026/great-britain/circuit official F1 circuit guide; Maggotts-Becketts-Chapel sequence well documented
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
  // Sources: https://www.formula1.com/en/racing/2026/italy/circuit official F1 circuit guide; Lesmo/Ascari/Parabolica naming long-established
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
  // Sources: https://www.formula1.com/en/racing/2026/japan/circuit official F1 circuit guide; 130R/Spoon/Degner naming well documented
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
  // Sources: https://www.formula1.com/en/racing/2026/emilia-romagna/circuit official F1 circuit guide; Tamburello/Villeneuve/Tosa/Rivazza naming long-established
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
  // Sources: https://www.formula1.com/en/racing/2026/spain/circuit official F1 circuit guide (numbered-turn convention)
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
  // Sources: https://driver61.com/circuit-guide/brands-hatch/ Driver61 circuit guide
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
  // Sources: https://www.formula1.com/en/racing/2026/germany/circuit historical F1 GP-circuit corner naming (Castrol-S, Mercedes Arena, Dunlop Kehre, Schumacher S, Veedol, NGK)
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
  // Sources: https://www.tracktitan.io/post/laguna-seca-track-guide Corkscrew/Andretti Hairpin/Rainey Curve naming well documented
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
  // Sources: https://www.formula1.com/en/racing/2026/netherlands/circuit official F1 circuit guide; Tarzan/Arie Luyendyk naming well documented
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
  // Sources: https://www.racingcircuits.info/oceania/australia/mount-panorama.html Bathurst corner naming (Hell Corner, Griffins Bend, Skyline, The Dipper, Forrest's Elbow, The Chase, Murray's Corner) long-established
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

  // ─── Bahrain International Circuit ───
  // Sources: https://www.formula1.com/en/racing/2026/bahrain/circuit official F1 circuit guide (numbered-turn convention)
  {
    id: "bahrain",
    character: "Desert circuit with abrasive, high-degradation surface and long straights broken by heavy braking zones. Rewards traction out of slow corners and good brake stability under floodlights.",
    corners: [
      { name: "Turn 1", type: "heavy-braking right-hander", technique: "Brake hard from top speed, late apex to open the exit for the run to Turn 2-3", trap: "Locking the front under the long straight-line braking zone" },
      { name: "Turn 4", type: "tight hairpin", technique: "Patient trail brake, prioritise a clean, early exit over apex speed", trap: "Carrying too much entry speed and running wide on exit, losing drive" },
      { name: "Turn 8", type: "long double-apex right", technique: "Progressive throttle through the second apex, use full exit width", trap: "Getting on power too early and sliding wide before the second apex" },
      { name: "Turn 10", type: "medium-speed left", technique: "Late apex, good exit feeds the run to the final sector", trap: "Understeer on entry from too much speed carried in" },
      { name: "Turn 11", type: "tight hairpin", technique: "Heavy braking, low gear, prioritise exit traction for the following straight", trap: "Wheelspin on exit on the abrasive, low-grip surface" },
      { name: "Turn 14", type: "final medium-speed right", technique: "Late apex, clean exit onto the start/finish straight is the priority", trap: "Compromised exit here costs time down the entire straight" },
    ],
    priorityCorners: ["Turn 4", "Turn 8", "Turn 11", "Turn 14"],
  },

  // ─── Jeddah Corniche Circuit ───
  // Sources: https://www.mclaren.com/racing/formula-1/2021/saudi-arabian-grand-prix/jeddah-track-guide/ ; https://formula-timer.com/circuit/jeddah — numbered-turn convention, braking-zone facts
  {
    id: "jeddah",
    character: "Fastest street circuit on the calendar — high average speed, narrow track, and unforgiving concrete walls. Demands commitment through blind, high-speed corners with little room for error.",
    corners: [
      { name: "Turn 1", type: "fast right-hander", technique: "Light lift, smooth turn-in, commit to the wall proximity", trap: "Lifting too much and losing momentum into the following sequence" },
      { name: "Turn 13", type: "long, banked, fast corner taken while still braking", technique: "High commitment corner — brake and turn-in simultaneously on the banking, smooth steering only", trap: "Any hesitation or correction near the wall is costly and dangerous" },
      { name: "Turn 22", type: "tight final-sector corner", technique: "Brake in a straight line before turn-in, prioritise a clean exit", trap: "Late braking near the wall leaving no margin for error" },
      { name: "Turn 27", type: "final corner onto pit straight", technique: "Late apex, clean exit — feeds the longest straight on the lap", trap: "Compromised exit here costs the most time of any corner on the lap" },
    ],
    priorityCorners: ["Turn 13", "Turn 22", "Turn 27"],
  },

  // ─── Albert Park (Melbourne) ───
  // Sources: https://www.formula1.com/en/racing/2026/australia/circuit official F1 circuit guide (numbered-turn convention)
  {
    id: "melbourne",
    character: "Fast, flowing semi-street circuit around Albert Park Lake, resurfaced and widened for a more permanent-track feel. Mix of high-speed sweeps and a few technical braking zones.",
    corners: [
      { name: "Turn 1", type: "medium-speed right", technique: "Firm braking from the straight, late apex to set up Turn 3", trap: "Over-braking and getting passed on the inside at the first-lap pinch point" },
      { name: "Turn 6", type: "fast, high-commitment left", technique: "Minimal lift, smooth steering, trust the grip through this quick section", trap: "Lifting or correcting mid-corner scrubs significant speed" },
      { name: "Turn 9-10", type: "fast, flowing left-right combination", technique: "Carry momentum through both parts with smooth direction changes", trap: "Over-driving the first part compromises the second apex" },
      { name: "Turn 11", type: "medium-speed corner leading to the lake section", technique: "Late apex, prioritise a strong exit onto the following straight", trap: "Early apex kills exit speed onto the straight" },
      { name: "Turn 13", type: "tight, technical final-sector corner", technique: "Hard braking, patient entry, clean exit onto the pit straight", trap: "Braking too late and running wide, losing drive onto the straight" },
    ],
    priorityCorners: ["Turn 1", "Turn 9-10", "Turn 13"],
  },

  // ─── Shanghai International Circuit ───
  // Sources: https://f1chronicle.com/the-technical-challenges-of-the-shanghai-circuits-snail-shell-corners-explained/ ; https://www.formula1.com/en/latest/article/circuit-guide-everything-you-need-to-know-about-the-shanghai-international.1b0f0ghbsPMRsHJoHTt6eB — snail-complex (T1-2, T11-13) verified
  {
    id: "shanghai",
    character: "Unique 'snail' shaped opening corner sequence with a very long back straight. Wide, sweeping corners test a car's mid-corner balance and aero efficiency.",
    corners: [
      { name: "Turn 1-2", type: "long, decreasing-radius double-apex right (the first 'snail')", technique: "Constant-radius-tightening corner — carry patience, keep tightening the line, don't apex too early", trap: "Early apex on the first part leaves the car with nowhere to go as the corner keeps tightening" },
      { name: "Turn 5-6", type: "fast, high-speed left-right combination", technique: "Commit with minimal lift, smooth steering through the direction change", trap: "Lifting unnecessarily through the high-speed section" },
      { name: "Turn 11-13", type: "increasing-radius spiral (the second 'snail'), feeding a 1.2km straight", technique: "Progressive throttle as the radius opens through the sequence, prioritise exit traction out of T13 — feeds the longest straight on the lap", trap: "Getting on power too early mid-spiral costs the exit onto the long straight after T13" },
      { name: "Turn 14", type: "final, medium-speed corner", technique: "Late apex, clean exit onto the pit straight", trap: "Compromised exit costs time all the way to the line" },
    ],
    priorityCorners: ["Turn 1-2", "Turn 11-13", "Turn 14"],
  },

  // ─── Miami International Autodrome ───
  // Sources: https://www.formula1.com/en/racing/2026/miami/circuit official F1 circuit guide (numbered-turn convention)
  {
    id: "miami",
    character: "Modern street-style circuit around Hard Rock Stadium with a mix of tight, technical sections and a long back straight. Bumpy surface and limited grip evolution demand a forgiving driving style.",
    corners: [
      { name: "Turn 1", type: "heavy-braking right-hander", technique: "Brake hard from the highest speed on the lap, late apex", trap: "Locking the front under the heaviest braking zone on the circuit" },
      { name: "Turn 7-10", type: "tight, technical stadium section", technique: "Patient, precise inputs — this low-speed section rewards mechanical grip over outright commitment", trap: "Over-driving any single corner in this sequence upsets the whole section" },
      { name: "Turn 13-14", type: "medium-speed chicane", technique: "Smooth direction change, use the exit kerb carefully to set up the following straight", trap: "Carrying too much speed in and running wide on exit" },
      { name: "Turn 17", type: "final corner onto pit straight", technique: "Late apex, clean exit is critical — feeds the main straight", trap: "Compromised exit here costs time down the entire straight" },
    ],
    priorityCorners: ["Turn 1", "Turn 7-10", "Turn 17"],
  },

  // ─── Circuit de Monaco ───
  // Sources: https://www.formula1.com/en/racing/2026/monaco/circuit official F1 circuit guide; Sainte Devote/Massenet/Casino/Mirabeau/Grand Hotel Hairpin/Portier/Tabac/Swimming Pool/Rascasse/Antony Noghes naming long-established
  {
    id: "monaco",
    character: "The ultimate test of precision — narrow, unforgiving street circuit with barriers inches from the racing line. Track position and error-free driving matter more than outright pace. Slowest average speed on the calendar.",
    corners: [
      { name: "Sainte Devote", type: "tight right-hander (T1)", technique: "Hard braking from the start/finish straight, clean early apex to set up the climb to Massenet", trap: "Contact-prone on the opening lap; running wide costs the run up the hill" },
      { name: "Massenet", type: "fast uphill left", technique: "Commit through the blind crest, smooth steering, trust the line to Casino Square", trap: "Lifting on the blind crest loses momentum into Casino Square" },
      { name: "Casino Square", type: "fast, undulating right", technique: "Ride the crest and camber changes with minimal steering correction", trap: "Bumps unsettle the car — over-correcting here compounds the problem" },
      { name: "Mirabeau", type: "tight downhill right", technique: "Firm braking on the downhill approach, late apex", trap: "Braking too late on the downhill and missing the apex" },
      { name: "Grand Hotel Hairpin", type: "slowest corner on the F1 calendar", technique: "Full steering lock, very low speed, precise placement to avoid the barriers", trap: "Clipping the barrier on entry or exit — almost zero margin for error" },
      { name: "Portier", type: "tight right before the tunnel", technique: "Late apex, clean exit is essential before entering the tunnel at speed", trap: "Poor exit here compromises tunnel entry speed" },
      { name: "Nouvelle Chicane", type: "heavy-braking chicane after the tunnel", technique: "Hard braking from tunnel speed, precise through the direction change", trap: "Braking too late after the tunnel — a common overtaking-crash point" },
      { name: "Tabac", type: "fast left-hander", technique: "Smooth commitment along the harbour wall", trap: "Any correction near the wall is highly costly" },
      { name: "Swimming Pool", type: "fast left-right-left chicane complex", technique: "Precise, rhythmic direction changes through the barriers with no margin", trap: "Overdriving any part of the complex risks wall contact" },
      { name: "Rascasse", type: "very tight, slow right-hander", technique: "Low speed, full commitment to the apex, patient throttle", trap: "Running wide on exit compromises the run to Antony Noghes" },
      { name: "Antony Noghes", type: "final corner onto the pit straight", technique: "Late apex, clean exit is critical — feeds the start/finish straight", trap: "Compromised exit costs time all the way to the line" },
    ],
    priorityCorners: ["Grand Hotel Hairpin", "Nouvelle Chicane", "Swimming Pool", "Antony Noghes"],
  },

  // ─── Circuit Gilles Villeneuve (Montreal) ───
  // Sources: https://www.formula1.com/en/racing/2026/canada/circuit official F1 circuit guide; Senna Esses/Wall of Champions naming well documented
  {
    id: "montreal",
    character: "Semi-permanent circuit on Île Notre-Dame — low grip, bumpy, and punishing of mistakes with concrete walls close to the track. Long straights reward good traction out of chicanes.",
    corners: [
      { name: "Turn 1-2", type: "fast right-left chicane", technique: "Firm braking, smooth direction change, prioritise a clean exit for the run to the hairpin", trap: "Over-driving the entry and running wide on the T2 exit" },
      { name: "Senna Esses", type: "flowing left-right-left sequence", technique: "Rhythm and smooth inputs through the direction changes, carry momentum", trap: "Fighting the car with big corrections instead of flowing through" },
      { name: "Wall of Champions", type: "final chicane before the pit straight", technique: "Precise, late braking, keep the car tight through the chicane with the wall right on exit", trap: "The exit wall has ended many races — any excess speed or wide line risks contact" },
    ],
    priorityCorners: ["Senna Esses", "Wall of Champions"],
  },

  // ─── Red Bull Ring (Spielberg) ───
  // Sources: https://www.formula1.com/en/racing/2026/austria/circuit official F1 circuit guide (numbered-turn convention)
  {
    id: "spielberg",
    character: "Short, high-elevation-change circuit in the Styrian mountains with only a handful of corners but big speed differentials. Traction out of the tight corners is everything given the short lap.",
    corners: [
      { name: "Turn 1", type: "heavy-braking uphill hairpin", technique: "Hard braking on the uphill approach, prioritise exit traction over entry speed", trap: "Wheelspin on the uphill exit loses time all the way up the following straight" },
      { name: "Turn 3", type: "tight, off-camber right", technique: "Patient trail brake, late apex, smooth throttle application on the tricky camber", trap: "Getting on power too early causes a snap on the off-camber exit" },
      { name: "Turn 4", type: "medium-speed uphill right", technique: "Carry speed from Turn 3 exit, commit through the uphill section", trap: "Under-committing here costs speed all the way to Turn 6" },
      { name: "Turn 6-7", type: "downhill right-left combination", technique: "Trust the downhill grip, smooth direction change, prioritise the exit onto the final straight", trap: "Braking too hard on the downhill entry and missing the ideal line" },
    ],
    priorityCorners: ["Turn 1", "Turn 3", "Turn 6-7"],
  },

  // ─── Hungaroring ───
  // Sources: https://www.formula1.com/en/racing/2026/hungary/circuit official F1 circuit guide (numbered-turn convention)
  {
    id: "budapest",
    character: "Tight, twisty circuit dubbed 'Monaco without the walls' — low average speed, high downforce, and few overtaking opportunities. Rewards precision and mid-corner rotation over outright straight-line speed.",
    corners: [
      { name: "Turn 1", type: "uphill medium-speed right", technique: "Firm braking on the uphill approach, late apex to set up Turn 2", trap: "Running wide compromises the tight Turn 2 entry" },
      { name: "Turn 4", type: "tight, technical right", technique: "Patient trail brake, low speed, precise placement", trap: "Carrying too much speed and running wide on exit" },
      { name: "Turn 11-12", type: "fast, flowing esses", technique: "Smooth, rhythmic direction changes, carry momentum through both parts", trap: "Over-driving the first part upsets the whole sequence" },
      { name: "Turn 13-14", type: "final medium-speed chicane", technique: "Late apex, clean exit is critical — feeds the pit straight", trap: "Compromised exit costs time down the entire straight" },
    ],
    priorityCorners: ["Turn 4", "Turn 11-12", "Turn 13-14"],
  },

  // ─── Baku City Circuit ───
  // Sources: https://www.formula1.com/en/racing/2026/azerbaijan/circuit official F1 circuit guide; Castle Section naming well documented
  {
    id: "baku",
    character: "Extreme-contrast street circuit — a super-narrow castle section through Baku's old town followed by the longest straight on the calendar. Demands precision at low speed and bravery at over 300 km/h.",
    corners: [
      { name: "Turn 1-3", type: "heavy-braking right-left-right complex", technique: "Firm braking from the start/finish straight, precise through the direction changes", trap: "Over-driving the entry and compromising the run through T2-T3" },
      { name: "Castle Section", type: "extremely narrow, low-speed section by the old city walls", technique: "Precision over speed — the track narrows dramatically, patient and exact placement", trap: "Any misjudgement here risks wall contact on both sides" },
      { name: "Turn 8", type: "tight corner exiting the castle section", technique: "Prioritise a clean exit — feeds the run back to the long back straight", trap: "Poor exit here costs time all the way down the straight" },
      { name: "Turn 15-16", type: "final chicane before the pit straight", technique: "Late, hard braking from very high speed, precise through the chicane", trap: "Braking too late from the highest straight-line speed on the calendar" },
    ],
    priorityCorners: ["Castle Section", "Turn 15-16"],
  },

  // ─── Circuit of the Americas (Austin) ───
  // Sources: https://www.formula1.com/en/racing/2026/united-states/circuit official F1 circuit guide (numbered-turn convention)
  {
    id: "austin",
    character: "Purpose-built circuit blending characteristics of famous corners worldwide — a steep uphill first corner, a flowing esses section inspired by Silverstone, and a long back straight into a hairpin.",
    corners: [
      { name: "Turn 1", type: "steep uphill hairpin", technique: "Brake hard on the blind uphill approach, commit to the apex without full visibility of the exit", trap: "Misjudging the uphill braking distance and running wide" },
      { name: "Esses (Turns 2-9)", type: "fast, flowing left-right sequence", technique: "Rhythm and smooth inputs through the direction changes, carry maximum speed", trap: "Over-driving any single apex disrupts the whole sequence" },
      { name: "Turn 11", type: "heavy-braking corner onto the back straight", technique: "Prioritise a clean exit to maximise speed down the following long straight", trap: "Compromised exit costs time over the entire back straight" },
      { name: "Turn 12", type: "tight hairpin at the end of the back straight", technique: "Hard braking from top speed, late apex, patient throttle on exit", trap: "Locking the front from the high braking speed" },
      { name: "Turn 15-18", type: "technical, tightening final-sector sequence", technique: "Patient, precise inputs through the tightening radius", trap: "Carrying too much speed into the sequence and running out of track" },
      { name: "Turn 19-20", type: "final corners onto the pit straight", technique: "Late apex, clean exit is critical for the run to the line", trap: "Poor exit here costs time down the entire pit straight" },
    ],
    priorityCorners: ["Turn 1", "Turn 11", "Turn 12", "Turn 19-20"],
  },

  // ─── Autódromo Hermanos Rodríguez (Mexico City) ───
  // Sources: https://www.formula1.com/en/racing/2026/mexico/circuit official F1 circuit guide; Foro Sol stadium section naming well documented
  {
    id: "mexico-city",
    character: "High-altitude circuit (2,200m) with thin air reducing aero and engine performance. Long back straight leads into a tight stadium section through the Foro Sol, surrounded by a packed grandstand.",
    corners: [
      { name: "Turn 1", type: "heavy-braking right-hander", technique: "Brake early to compensate for reduced aero grip at altitude, late apex", trap: "Misjudging braking distance due to thinner air reducing downforce and drag" },
      { name: "Turn 4-6", type: "fast, flowing esses", technique: "Smooth, rhythmic direction changes, trust the grip despite the altitude", trap: "Over-driving the reduced-grip conditions at altitude" },
      { name: "Stadium Section", type: "tight, technical corners through the Foro Sol baseball stadium", technique: "Patient, precise low-speed inputs, use the atmosphere but stay focused on the tightening line", trap: "Getting distracted by the stadium crowd and missing braking points" },
      { name: "Final Corner", type: "long, tightening corner onto the pit straight", technique: "Progressive throttle as the corner opens, clean exit is critical", trap: "Early throttle application before the corner fully opens causes a slide" },
    ],
    priorityCorners: ["Turn 1", "Stadium Section", "Final Corner"],
  },

  // ─── Autódromo José Carlos Pace (Interlagos) ───
  // Sources: https://www.formula1.com/en/racing/2026/brazil/circuit official F1 circuit guide; Senna S/Ferradura/Junção/Subida dos Boxes naming long-established
  {
    id: "interlagos",
    character: "Anti-clockwise circuit with dramatic elevation changes packed into a short lap. Bumpy surface and unpredictable weather make it a driver favourite. Flows well but punishes hesitation.",
    corners: [
      { name: "Senna S", type: "steep downhill left-right (T1-T2)", technique: "Brake on the downhill approach, commit through the direction change without over-slowing", trap: "Braking too late on the downhill and running wide at the second part" },
      { name: "Descida do Lago", type: "fast downhill sweeping left", technique: "Carry speed downhill with smooth steering, trust the grip", trap: "Lifting unnecessarily on the downhill kills momentum" },
      { name: "Ferradura", type: "long, tightening left-hander", technique: "Patient, progressive line as the corner tightens, don't apex too early", trap: "Early apex leaves nowhere to go as the corner keeps tightening" },
      { name: "Junção", type: "tight, technical right-hander", technique: "Firm braking, late apex, prioritise a strong exit onto the following straight", trap: "Poor exit here costs significant time on the run back to the start/finish" },
      { name: "Subida dos Boxes", type: "final uphill corner onto the pit straight", technique: "Late apex, progressive throttle up the hill", trap: "Early throttle on the uphill exit causes wheelspin" },
    ],
    priorityCorners: ["Senna S", "Ferradura", "Junção", "Subida dos Boxes"],
  },

  // ─── Yas Marina Circuit ───
  // Sources: https://www.formula1.com/en/racing/2026/abu-dhabi/circuit official F1 circuit guide (numbered-turn convention)
  {
    id: "yas-marina",
    character: "Modern circuit combining long straights, a technical marina section, and a hotel-adjacent corner sequence. Wide, smooth surface with good grip levels; final sector rewards precision for a strong run to the line.",
    corners: [
      { name: "Turn 1", type: "heavy-braking right-hander", technique: "Brake hard from the main straight, late apex to open the following sequence", trap: "Over-braking and losing momentum into the following corners" },
      { name: "Turn 5-7", type: "fast, flowing sequence", technique: "Smooth, rhythmic direction changes, carry as much speed as possible", trap: "Over-driving any single apex disrupts the whole sequence" },
      { name: "Turn 9", type: "medium-speed corner leading toward the hotel section", technique: "Late apex, prioritise a strong exit", trap: "Early apex costs speed through the following corners" },
      { name: "Hotel Corners", type: "technical sequence beneath the Yas Viceroy hotel", technique: "Patient, precise inputs through the tightening, visually distracting section", trap: "Losing focus under the hotel and missing braking or turn-in points" },
      { name: "Marina Section", type: "tight, technical final-sector corners", technique: "Prioritise clean, low-speed precision over outright commitment", trap: "Carrying too much speed into the marina section and running wide" },
    ],
    priorityCorners: ["Hotel Corners", "Marina Section"],
  },

  // ─── Circuit Paul Ricard ───
  // Sources: https://www.formula1.com/en/latest/article.circuit-guide-paul-ricard official F1/circuit character; Signes-Beausset naming well documented
  {
    id: "paul-ricard",
    character: "Wide, modern circuit with extensive run-off (blue/red asphalt in place of gravel) and the very long Mistral Straight bisected by an optional chicane. Rewards aero efficiency and braking stability.",
    corners: [
      { name: "Turn 1", type: "medium-speed right-hander", technique: "Firm braking, late apex to set up the run through the following corners", trap: "Using too much of the wide run-off and carrying an unrealistic entry speed" },
      { name: "Signes-Beausset", type: "fast, high-commitment right-left combination", technique: "Minimal lift, smooth steering, trust the grip through this high-speed section", trap: "Lifting or correcting mid-corner scrubs significant speed before the Mistral straight" },
      { name: "Mistral Straight Chicane", type: "chicane bisecting the long straight (variant-dependent)", technique: "Hard, late braking from top speed if the chicane is in use, precise through the direction change", trap: "Misjudging braking distance from the very high straight-line speed" },
      { name: "Turn 8", type: "final chicane before the pit straight", technique: "Late apex, clean exit is critical — feeds the start/finish straight", trap: "Compromised exit costs time down the entire straight" },
    ],
    priorityCorners: ["Signes-Beausset", "Turn 8"],
  },

  // ─── Misano World Circuit ───
  // Sources: https://coachdaveacademy.com/tutorials/misano-world-circuit-track-guide/ ; https://inmotion.dhl/en/motogp/article/the-origins-of-names-for-turns-in-motogp — Curvone (T11), Quercia (T12), Tramonto (T16) verified
  {
    id: "misano",
    character: "Adriatic-coast circuit best known as MotoGP's home in Italy, adapted for cars. Tight, technical layout with a mix of medium-speed corners and few pure straights — demands a well-balanced, agile car.",
    corners: [
      { name: "Turn 1", type: "heavy-braking right-hander", technique: "Brake hard from the front straight, late apex to open the following sequence", trap: "Over-braking and losing momentum into the technical section that follows" },
      { name: "Curvone", type: "long, fast right-hander", technique: "Commit with smooth steering, carry speed through the long radius", trap: "Lifting mid-corner kills momentum through this key speed section" },
      { name: "Quercia", type: "medium-speed technical corner", technique: "Late apex, patient throttle application on exit", trap: "Early throttle causes a slide on the tightening exit" },
      { name: "Tramonto", type: "final-sector corner leading to the last complex", technique: "Prioritise a clean, well-placed line to set up the run to the finish", trap: "Carrying too much speed in and running wide, compromising the final corners" },
    ],
    priorityCorners: ["Curvone", "Quercia"],
  },

  // ─── Kyalami Grand Prix Circuit ───
  // Sources: https://f1.fandom.com/wiki/Kyalami_Circuit ; https://en.wikipedia.org/wiki/Kyalami — Crowthorne Corner and The Kink verified
  {
    id: "kyalami",
    character: "High-altitude South African circuit with a fast, flowing layout and dramatic elevation changes. Thinner air reduces aero and engine performance, similar to Mexico City.",
    corners: [
      { name: "Turn 1", type: "heavy-braking right-hander", technique: "Brake early to account for reduced aero grip at altitude, late apex", trap: "Misjudging braking distance due to the thinner air" },
      { name: "Crowthorne", type: "fast, sweeping corner", technique: "Commit with smooth steering, trust the grip despite the altitude", trap: "Lifting unnecessarily and losing momentum" },
      { name: "The Kink", type: "high-speed direction change", technique: "Minimal steering input, stay smooth through the fast section", trap: "Any correction at speed here is costly" },
      { name: "Final Corner", type: "medium-speed corner onto the pit straight", technique: "Late apex, clean exit is critical for the run to the line", trap: "Poor exit here costs time down the entire straight" },
    ],
    priorityCorners: ["Turn 1", "Final Corner"],
  },

  // ─── Donington Park ───
  // Sources: https://driver61.com/circuit-guide/donington/ — Redgate/Craner Curves/Old Hairpin/McLean's/Coppice verified
  {
    id: "donington",
    character: "Historic, undulating British circuit with dramatic elevation change through the Craner Curves. Technical and flowing in equal measure — rewards precision and confidence over blind crests.",
    corners: [
      { name: "Redgate", type: "medium-speed right-hander (T1)", technique: "Firm braking from the start/finish straight, late apex to set up the downhill run", trap: "Running wide compromises the entry to the Craner Curves" },
      { name: "Craner Curves", type: "fast, downhill sweeping sequence", technique: "Commit through the downhill esses with smooth, minimal steering", trap: "Braking or lifting mid-sequence unsettles the car on the downhill camber" },
      { name: "Old Hairpin", type: "tight, slow corner at the bottom of the hill", technique: "Hard braking after the fast downhill section, patient throttle on exit", trap: "Carrying too much speed from Craner Curves and missing the braking point" },
      { name: "McLeans", type: "fast, uphill left-hander", technique: "Commit through the uphill corner, smooth steering", trap: "Lifting on the uphill entry kills exit speed" },
      { name: "Coppice", type: "medium-speed final corner", technique: "Late apex, clean exit is critical — feeds the run to the line", trap: "Poor exit here costs time down the entire straight" },
    ],
    priorityCorners: ["Craner Curves", "Old Hairpin", "Coppice"],
  },

  // ─── Oulton Park ───
  // Sources: https://driver61.com/circuit-guide/oulton-park/ — Old Hall/Cascades/Island Bend/Lodge verified
  {
    id: "oulton-park",
    character: "Undulating, tree-lined British circuit through parkland with blind crests and off-camber corners. Technical and demanding — rewards local knowledge of the many blind sections.",
    corners: [
      { name: "Old Hall", type: "medium-speed right-hander", technique: "Firm braking, late apex, prioritise a clean line through the technical opening corner", trap: "Running wide costs momentum into the following section" },
      { name: "Cascades", type: "fast, downhill, blind left-hander", technique: "Commit through the blind crest, trust the line and carry speed downhill", trap: "Lifting on the blind entry loses significant momentum" },
      { name: "Island Bend", type: "fast right-hander", technique: "Smooth, committed steering, carry speed through the sweeping radius", trap: "Any correction mid-corner scrubs speed" },
      { name: "Lodge Corner", type: "final tight corner onto the pit straight", technique: "Late apex, clean exit is critical — feeds the run to the line", trap: "Poor exit here costs time down the entire straight" },
    ],
    priorityCorners: ["Cascades", "Lodge Corner"],
  },

  // ─── Snetterton Circuit ───
  // Sources: https://driver61.com/circuit-guide/snetterton-300/ ; https://www.thecheckeredflag.co.uk/2011/03/snetterton-unveils-new-corner-names/ — Riches/Wilson/Coram/Palmer verified
  {
    id: "snetterton",
    character: "Fast, flat, flowing former airfield circuit in Norfolk. High-speed corners dominate — momentum and smooth inputs matter more than heavy braking.",
    corners: [
      { name: "Riches", type: "fast, sweeping right-hander", technique: "Commit with smooth steering, carry maximum speed through the long radius", trap: "Lifting mid-corner kills momentum through this key speed section" },
      { name: "Wilson", type: "medium-speed technical corner", technique: "Late apex, patient throttle application on exit", trap: "Early throttle causes a slide on the tightening exit" },
      { name: "Coram", type: "long, fast sweeping right-hander", technique: "Commit through the long radius with smooth, minimal steering correction", trap: "Any correction at speed here scrubs significant time" },
      { name: "Palmer", type: "final corner onto the pit straight", technique: "Late apex, clean exit is critical — feeds the run to the line", trap: "Poor exit here costs time down the entire straight" },
    ],
    priorityCorners: ["Riches", "Coram", "Palmer"],
  },

  // ─── Watkins Glen International ───
  // Sources: https://www.imsa.com/watkins-glen/ track facts; The Esses/The Boot/Bus Stop/Inner Loop naming well documented
  {
    id: "watkins-glen",
    character: "Historic, high-speed American road course with dramatic elevation changes and the famous Esses sequence. Rewards commitment and smooth inputs through fast, flowing corners.",
    corners: [
      { name: "Turn 1", type: "heavy-braking right-hander", technique: "Brake hard from the front straight, late apex to set up the Esses", trap: "Over-braking and losing the momentum needed for the following section" },
      { name: "The Esses", type: "fast, flowing left-right sequence", technique: "Rhythm and smooth inputs through the direction changes, carry maximum speed", trap: "Over-driving any single apex disrupts the whole sequence" },
      { name: "The Boot", type: "long, tightening back-straight corner", technique: "Patient, progressive line as the corner tightens", trap: "Early apex leaves nowhere to go as the corner keeps tightening" },
      { name: "Bus Stop Chicane", type: "tight chicane before the final corner", technique: "Hard, late braking, precise through the direction change", trap: "Carrying too much speed in and running out of track on exit" },
      { name: "Inner Loop", type: "final tight corner onto the pit straight", technique: "Late apex, clean exit is critical — feeds the start/finish straight", trap: "Poor exit here costs time down the entire straight" },
    ],
    priorityCorners: ["The Esses", "Bus Stop Chicane", "Inner Loop"],
  },

  // ─── Nürburgring Nordschleife ───
  // Sources: https://www.nuerburgring.de/en/ ; long-established Nordschleife corner naming (Hatzenbach, Flugplatz, Adenauer Forst, Fuchsröhre, Bergwerk, Karussell, Pflanzgarten, Döttinger Höhe)
  {
    id: "nordschleife",
    character: "The 'Green Hell' — a 20.8km, 73-corner ribbon through the Eifel forest with extreme elevation changes and blind crests. Demands memorisation and bravery; mistakes are severely punished by close barriers.",
    corners: [
      { name: "Hatzenbach", type: "fast, flowing forest section", technique: "Commit through the blind, undulating corners with smooth steering", trap: "Lifting unnecessarily on the blind crests loses significant time" },
      { name: "Flugplatz", type: "fast crest where the car goes light", technique: "Stay smooth as the car unloads over the crest, minimal steering correction", trap: "Aggressive inputs while the car is light causes a snap" },
      { name: "Adenauer Forst", type: "tight, technical double corner", technique: "Firm braking, patient double-apex line", trap: "Carrying too much speed into the tightening second part" },
      { name: "Fuchsröhre", type: "very fast, dipping section", technique: "Commit through the compression at high speed, trust the car", trap: "Braking or lifting in the dip unsettles the car badly" },
      { name: "Bergwerk", type: "slow, tight right-hander after a fast section", technique: "Hard braking from very high speed, patient entry", trap: "Misjudging the braking point after the fast approach — a notorious accident site" },
      { name: "Karussell", type: "banked, off-camber left-hander", technique: "Use the banked concrete gutter to carry speed through the corner", trap: "Missing the banking and taking the corner conventionally loses significant time" },
      { name: "Pflanzgarten", type: "fast, undulating jump section", technique: "Commit through the compressions and crests with smooth inputs", trap: "The car can become airborne here — excess speed or poor line risks a big moment" },
      { name: "Döttinger Höhe", type: "long flat-out straight before the final corners", technique: "Full commitment, prepare early for the braking zone at the end", trap: "Not preparing early enough for the heavy braking after the flat-out section" },
    ],
    priorityCorners: ["Bergwerk", "Karussell", "Pflanzgarten"],
  },

  // ─── Marina Bay Street Circuit (Singapore) ───
  // Corner names/numbers omitted deliberately — layout has changed materially between seasons
  // (notably the 2023 removal of the Turn 16-19 chicane); only generic T# labels used here
  // to avoid citing a sequence that may no longer exist. Character description sourced from
  // widely-reported circuit characteristics (Driver61, F1 official circuit guide).
  // Sources: https://www.formula1.com/en/racing/2026/singapore/circuit — deliberately generic Turn-N labels; layout has changed materially between seasons (see comment above)
  {
    id: "singapore",
    character: "Longest, most physically demanding street circuit on the calendar, raced at night under floodlights. Bumpy, narrow, and wall-lined — high downforce and total concentration are essential; the safety-car rate here is the highest on the calendar.",
    corners: [
      { name: "Turn 1", type: "heavy-braking corner off the front straight", technique: "Brake hard, late apex, prioritise a clean exit for the technical section that follows", trap: "Over-braking and getting out of position for the tight sequence ahead" },
      { name: "Turn 7", type: "tight, technical street corner", technique: "Patient, precise inputs — mechanical grip matters more than commitment here", trap: "Clipping a wall from an over-ambitious line" },
      { name: "Turn 14", type: "medium-speed corner in the middle sector", technique: "Late apex, smooth throttle application on the bumpy surface", trap: "Bumps unsettling the car mid-corner and causing a wide exit" },
      { name: "Turn 18", type: "final-sector corner onto the run to the line", technique: "Prioritise a clean exit — feeds the final part of the lap", trap: "Compromised exit here costs time over the remainder of the lap" },
    ],
    priorityCorners: ["Turn 1", "Turn 7", "Turn 18"],
  },

  // ─── Las Vegas Street Circuit ───
  // Corner numbers kept generic — this is a newer addition to the calendar with limited
  // independently-verified corner-name sourcing; only the well-documented circuit character
  // (long Strip straight, very high top speed, cold-track grip) is asserted with confidence.
  // Sources: https://www.formula1.com/en/racing/2026/las-vegas/circuit — deliberately generic Turn-N labels (see comment above)
  {
    id: "las-vegas",
    character: "High-speed street circuit down the Las Vegas Strip, run at night in cold desert-winter track temperatures. Very long straights favour low drag; low ambient and track temperature make tyre warm-up and braking stability a persistent challenge.",
    corners: [
      { name: "Turn 1", type: "heavy-braking corner off the main straight", technique: "Brake early to account for cold-track grip levels, late apex", trap: "Locking a cold front tyre under braking" },
      { name: "Turn 5", type: "fast street corner", technique: "Commit smoothly, respect the reduced grip from low track temperature", trap: "Overdriving the entry on a cold tyre and sliding wide" },
      { name: "Turn 12-14", type: "technical street section", technique: "Patient, precise inputs through the tighter sequence", trap: "Wall contact from an overly ambitious line in the tight section" },
      { name: "Final Corner", type: "corner onto the long Strip straight", technique: "Clean exit is critical — feeds the longest straight on the lap", trap: "Compromised exit costs significant time down the following straight" },
    ],
    priorityCorners: ["Turn 1", "Final Corner"],
  },

  // ─── Lusail International Circuit (Qatar) ───
  // Corner numbers only — deliberately avoids naming any corner ("Bit-Kurve" style errors
  // have previously been hallucinated for this track). Character sourced from well-documented
  // circuit facts (long, sweeping MotoGP-derived layout, desert night race).
  // Sources: https://www.formula1.com/en/racing/2026/qatar/circuit — deliberately generic Turn-N labels (see comment above)
  {
    id: "lusail",
    character: "Long, flowing former MotoGP circuit with a mix of high-speed sweeps and tighter technical corners, raced at night in the desert. Abrasive surface and sustained high-speed corners put a premium on tyre management.",
    corners: [
      { name: "Turn 1", type: "heavy-braking corner off the main straight", technique: "Brake hard, late apex to set up the following sequence", trap: "Over-braking and losing momentum into the technical section" },
      { name: "Turn 6", type: "fast, sweeping corner", technique: "Commit with smooth steering, manage tyre load through the sustained load", trap: "Overloading the tyre through a long high-speed corner and sliding wide late" },
      { name: "Turn 12", type: "technical, medium-speed corner", technique: "Late apex, patient throttle application on exit", trap: "Early throttle causing a slide on the tightening exit" },
      { name: "Turn 16", type: "final corner onto the pit straight", technique: "Clean exit is critical — feeds the run to the line", trap: "Compromised exit costs time down the entire straight" },
    ],
    priorityCorners: ["Turn 1", "Turn 6", "Turn 16"],
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
  // Nordschleife must be checked before the generic Nürburgring GP match below,
  // since "nürburgring nordschleife" / "nürburgring 24h" both contain "nurburgring".
  [["nordschleife", "nurburgring 24", "24h"], "nordschleife"],
  [["nürburgring", "nurburgring", "nuerburgring"], "nurburgring"],
  [["spa", "francorchamps"], "spa"],
  [["silverstone"], "silverstone"],
  [["monza"], "monza"],
  [["suzuka"], "suzuka"],
  [["imola", "enzo e dino"], "imola"],
  [["barcelona", "catalunya", "catalonia", "montmeló", "montmelo"], "catalunya"],
  [["zandvoort"], "zandvoort"],
  [["bahrain", "sakhir"], "bahrain"],
  [["jeddah"], "jeddah"],
  [["melbourne", "albert park"], "melbourne"],
  [["shanghai"], "shanghai"],
  [["miami"], "miami"],
  [["monaco", "monte carlo"], "monaco"],
  [["gilles villeneuve", "montreal"], "montreal"],
  [["red bull ring", "spielberg"], "spielberg"],
  [["hungaroring", "budapest"], "budapest"],
  [["baku"], "baku"],
  [["circuit of the americas", "cota", "austin"], "austin"],
  [["hermanos rodriguez", "hermanos rodríguez", "mexico city", "mexico"], "mexico-city"],
  [["interlagos", "jose carlos pace", "josé carlos pace", "sao paulo", "são paulo"], "interlagos"],
  [["yas marina", "abu dhabi"], "yas-marina"],
  [["paul ricard"], "paul-ricard"],
  [["misano"], "misano"],
  [["kyalami"], "kyalami"],
  [["donington"], "donington"],
  [["oulton park"], "oulton-park"],
  [["snetterton"], "snetterton"],
  [["watkins glen"], "watkins-glen"],
  [["marina bay", "singapore"], "singapore"],
  [["las vegas"], "las-vegas"],
  [["lusail"], "lusail"],
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
