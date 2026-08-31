export function timestampForFilename(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}
