const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"] as const;
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"] as const;

export const liveEngineerIntegerAtoms = (value: number): string[] => {
  if (!Number.isInteger(value) || value < 0 || value > 999) return [];
  if (value < 20) return [ONES[value]!];
  if (value < 100) return value % 10 ? [TENS[Math.floor(value / 10)]!, ONES[value % 10]!] : [TENS[value / 10]!];
  const remainder = value % 100;
  return [ONES[Math.floor(value / 100)]!, "hundred", ...(remainder ? liveEngineerIntegerAtoms(remainder) : [])];
};

export function liveEngineerNumberAtoms(value: number, decimals = 1): string[] {
  if (!Number.isFinite(value) || value < 0 || value > 999) return [];
  const rounded = Number(value.toFixed(decimals));
  const integer = Math.floor(rounded);
  const fraction = Math.round((rounded - integer) * 10 ** decimals);
  const atoms = integer === 0 && fraction ? [] : liveEngineerIntegerAtoms(integer);
  if (!fraction || decimals === 0) return atoms;
  const digits = String(fraction).padStart(decimals, "0").split("").map((digit) => ONES[Number(digit)]!);
  return [...atoms, "point", ...digits];
}

export function formatLiveEngineerDeltaText(deltaMs: number, decimals = 1): string {
  const atoms = liveEngineerNumberAtoms(Math.abs(deltaMs) / 1000, decimals);
  return `${atoms.join(" ")} second${Math.abs(deltaMs) === 1000 ? "" : "s"}`;
}
