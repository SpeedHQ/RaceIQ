export interface ParsedLapTime {
  seconds: number;
  raw: string;
  track: string | null;
}

// M:SS(.mmm) or MM:SS(.mmm), colon or dot between S and ms.
const TIME_RE = /\b(\d{1,2}):([0-5]\d)(?:[.:](\d{1,3}))?\b/;

const TRACK_WORDS: [RegExp, string][] = [
  [/le\s*mans|la\s*sarthe/i, "Le Mans"],
  [/n[uü]rb|nordschleife|green\s*hell/i, "Nürburgring"],
  [/spa|francorchamps/i, "Spa"],
];

export function parseLapTime(description: string | null | undefined): ParsedLapTime | null {
  if (!description) return null;
  const m = TIME_RE.exec(description);
  if (!m) return null;
  const min = Number(m[1]);
  const sec = Number(m[2]);
  const ms = m[3] ? Number(`${m[3]}000`.slice(0, 3)) : 0;
  // Reject implausible laps (> 15 min) to avoid dates/versions.
  if (min > 15) return null;
  const seconds = min * 60 + sec + ms / 1000;
  const raw = m[3] ? `${min}:${m[2]}.${m[3]}` : `${min}:${m[2]}`;
  const window = description.slice(Math.max(0, m.index - 24), m.index + m[0].length + 24);
  let track: string | null = null;
  for (const [re, label] of TRACK_WORDS) {
    if (re.test(window)) {
      track = label;
      break;
    }
  }
  return { seconds, raw, track };
}
