const UTC_SUFFIX = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** Parse database UTC timestamps, including SQLite's timezone-naive datetime text. */
export function parseUtcTimestamp(value: string): Date {
  const normalized = DATE_TIME.test(value) && !UTC_SUFFIX.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  return new Date(normalized);
}
