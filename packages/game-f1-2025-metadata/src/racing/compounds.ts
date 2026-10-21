const COMPOUND_BY_ID: Readonly<Record<number, string>> = {
  16: "soft",
  17: "medium",
  18: "hard",
  7: "inter",
  8: "wet",
};

export function getF1CompoundName(visualCompound: number): string {
  return COMPOUND_BY_ID[visualCompound] ?? "unknown";
}
