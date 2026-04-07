const COUNTRY_NAMES: Record<string, string> = {
  ARE: "UAE", AUS: "Australia", AUT: "Austria", AZE: "Azerbaijan",
  BEL: "Belgium", BHR: "Bahrain", BRA: "Brazil", CAN: "Canada",
  CHN: "China", DEU: "Germany", ESP: "Spain", FRA: "France",
  GBR: "Great Britain", HUN: "Hungary", ITA: "Italy", JPN: "Japan",
  MCO: "Monaco", MEX: "Mexico", NLD: "Netherlands", PRT: "Portugal",
  QAT: "Qatar", RUS: "Russia", SAU: "Saudi Arabia", SGP: "Singapore",
  USA: "USA", VNM: "Vietnam",
};

export function countryName(code: string): string {
  return COUNTRY_NAMES[code.toUpperCase()] ?? code.toUpperCase();
}
