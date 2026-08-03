/**
 * Parse one CSV line with RFC-4180-compatible quoting.
 * Supports embedded delimiters and escaped quote pairs.
 */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && quoted && line[i + 1] === '"') {
      field += '"';
      i++;
      continue;
    }

    if (ch === '"') {
      quoted = !quoted;
      continue;
    }

    if (ch === "," && !quoted) {
      fields.push(field);
      field = "";
      continue;
    }

    field += ch;
  }

  fields.push(field);
  return fields;
}

