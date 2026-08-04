export type CsvCellValue = string | number | boolean;

export function csvCell(value: CsvCellValue): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
