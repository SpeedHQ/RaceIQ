/**
 * AC Evo utility functions for reading C struct data from buffers.
 *
 * AC Evo v0.6 uses char[N] (single-byte ASCII/UTF-8) for strings, unlike ACC
 * which used wchar_t[N] (UTF-16LE). Two separate readers live in this project.
 */

import { ACEVO_SESSION_TYPE_NAMES } from "@raceiq/capture-formats/ac-evo/structs";

export function resolveAcEvoSessionType(code: number, name: string): string {
  switch (name.trim().toLowerCase().replace(/[-_]+/g, " ")) {
    case "practice": return "practice";
    case "qualifying": return "qualifying";
    case "race": return "race";
    case "time attack":
    case "time trial": return "time_attack";
    case "hot stint": return "hot_stint";
    case "cruise": return "cruise";
    default: return ACEVO_SESSION_TYPE_NAMES[code] ?? "unknown";
  }
}

/** Read a null-terminated single-byte string from a buffer (char[maxBytes]). */
export function readCString(buf: Buffer, offset: number, maxBytes: number): string {
  const slice = buf.slice(offset, offset + maxBytes);
  let end = slice.length;
  for (let i = 0; i < slice.length; i++) {
    if (slice[i] === 0) {
      end = i;
      break;
    }
  }
  return slice.slice(0, end).toString("utf8");
}
