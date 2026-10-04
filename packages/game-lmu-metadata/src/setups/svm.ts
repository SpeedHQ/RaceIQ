/*
 * Adapted from Setup Ripple LMU by JojoJing, commit
 * 6239277da04a1f09027591aaa00fd047780b6efa. Copyright (c) 2026 JojoJing.
 * Licensed under the MIT License.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { resolveLMUCar } from "../catalog";
import { getSvmFieldDescriptor } from "./fields";
import { getSvmFieldAccess } from "./capabilities";

export interface SvmLine { start: number; contentEnd: number; end: number; terminator: Uint8Array }
export interface SvmSetting {
  id: string; section: string; key: string; index: number; display: string; line: number;
  indexStart: number; indexEnd: number; displayStart: number | null; displayEnd: number | null;
  markerStart: number | null; markerEnd: number | null; markerDelta: number;
}
export interface SvmDocument {
  originalBytes: Uint8Array; lines: readonly SvmLine[]; vehicleClass: string;
  className: "Hypercar" | "LMP2" | "LMP3" | "GT3" | "GTE" | null;
  carName: string; carId: string | null; identityWarning: string | null; symmetric: number | null;
  settings: ReadonlyMap<string, SvmSetting>;
}
export type SvmParseResult = { ok: true; document: SvmDocument } | { ok: false; error: string; line: number | null };
export interface SvmEdit { id: string; delta: number }
export interface SvmDiff { id: string; kind: "changed" | "added" | "removed"; before: { index: number; display: string } | null; after: { index: number; display: string } | null }
const utf8 = new TextDecoder("utf-8", { fatal: true });
const cp1252 = new TextDecoder("windows-1252");
const encoder = new TextEncoder();
const HEADER = /^\s*VehicleClassSetting\s*=\s*"([^"\r\n]+)"\s*(?:\/\/.*)?$/i;
const MARKER = / \(edited, ([1-9]\d*) clicks? (up|down)\)$/;
const CLASS_BY_TOKEN: Record<string, SvmDocument["className"]> = { hypercar: "Hypercar", lmdh: "Hypercar", lmh: "Hypercar", lmp2: "LMP2", lmp3: "LMP3", gt3: "GT3", gte: "GTE" };
function fail(error: string, line: number | null): SvmParseResult { return { ok: false, error, line }; }
function decode(bytes: Uint8Array, utf8Encoded: boolean): string { return utf8Encoded ? utf8.decode(bytes) : cp1252.decode(bytes); }
function charOffset(text: string, index: number, utf8Encoded: boolean): number { return utf8Encoded ? encoder.encode(text.slice(0, index)).length : index; }
function lineMap(bytes: Uint8Array): SvmLine[] {
  const lines: SvmLine[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) {
    const contentEnd = i > start && bytes[i - 1] === 13 ? i - 1 : i;
    lines.push({ start, contentEnd, end: i + 1, terminator: bytes.slice(contentEnd, i + 1) }); start = i + 1;
  }
  if (start < bytes.length || bytes.length === 0) lines.push({ start, contentEnd: bytes.length, end: bytes.length, terminator: new Uint8Array() });
  return lines;
}
function removeIdentityTokens(value: string): { vehicleClass: string; className: SvmDocument["className"] } {
  const tokens = value.trim().split(/[ \t]+/);
  let className: SvmDocument["className"] = null;
  const kept = tokens.filter((token) => {
    const cls = /^(Hypercar|LMDh|LMH|LMP2|LMP3|LMGT3|GT3|GTE)(?:_.*)?$/i.exec(token);
    if (cls) { className = CLASS_BY_TOKEN[cls[1]!.toLowerCase().replace("lmgt3", "gt3")] ?? null; return false; }
    return !/^(?:(?:WEC|ELMS|IMSA|WEG|LMDh)\d{2,4}|\d{4})$/i.test(token);
  });
  const vehicleClass = kept.join(" ").replace(/_LMGT3$/i, "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return { vehicleClass, className };
}
function resolveIdentity(header: string, vehicleComment: string): { carName: string; carId: string | null; className: SvmDocument["className"]; warning: string | null } {
  const parsed = removeIdentityTokens(header);
  const aliases: string[] = [];
  for (const match of vehicleComment.matchAll(/Vehicles[\\/]+([^\\/\s]+)|([^\\/\s]+\.veh)\b/gi)) aliases.push(match[1] ?? (match[2] ?? "").replace(/\.veh$/i, ""));
  let car = undefined;
  for (const alias of aliases) { car = resolveLMUCar(alias); if (car) break; }
  if (!car && parsed.vehicleClass) car = resolveLMUCar(parsed.vehicleClass.replace(/\s+\d{4}$/, "").trim());
  const classToken = parsed.className;
  const catalogClass = car?.class.toLowerCase();
  const conflicting = Boolean(car && classToken && catalogClass !== classToken.toLowerCase() && !(classToken === "Hypercar" && catalogClass === "hypercar"));
  return { carName: parsed.vehicleClass || header.trim(), carId: conflicting ? null : car?.id ?? null, className: conflicting ? null : classToken ?? (car?.class as SvmDocument["className"] | undefined) ?? null, warning: conflicting ? `Header class conflicts with catalog class ${car!.class}` : null };
}
export function parseSVM(input: Uint8Array): SvmParseResult {
  const bytes = input.slice();
  if (bytes.some((byte) => byte === 0)) return fail("NUL-containing or UTF-16 input is not supported", null);
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return fail("UTF-16 input is not supported", null);
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const lines = lineMap(bytes);
  const settings = new Map<string, SvmSetting>();
  let section = ""; let header: string | null = null; let symmetric: number | null = null;
  let recognized = 0; let vehicleComment = "";
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    const prefix = lineIndex === 0 && hasBom ? 3 : 0;
    const raw = bytes.subarray(line.start + prefix, line.contentEnd);
    let utf8Encoded = true;
    try { utf8.decode(raw); } catch { utf8Encoded = false; }
    const text = decode(raw, utf8Encoded);
    const trimmed = text.trim();
    if (!trimmed || /^[;#]/.test(trimmed)) continue;
    if (trimmed.startsWith("//")) { if (/^\/\/VEH=/i.test(trimmed)) vehicleComment += `${trimmed}\n`; continue; }
    const sectionMatch = /^\s*\[([^\]]+)\]\s*$/.exec(text);
    if (sectionMatch) { section = sectionMatch[1]!.trim().toUpperCase(); continue; }
    if (!section) {
      const headerMatch = HEADER.exec(text);
      if (headerMatch) { if (header !== null) return fail("Duplicate VehicleClassSetting header", lineIndex + 1); header = headerMatch[1]!.trim(); }
      const symmetricMatch = /^\s*Symmetric\s*=\s*([+-]?\d+)\s*(?:\/\/.*)?$/i.exec(text);
      if (!headerMatch && /^[ \t]*VehicleClassSetting\b/i.test(text)) return fail("Malformed quoted VehicleClassSetting header", lineIndex + 1);
      if (symmetricMatch) { const parsed = Number(symmetricMatch[1]); if (!Number.isSafeInteger(parsed)) return fail("Unsafe Symmetric integer", lineIndex + 1); symmetric = parsed; }
      continue;
    }
    if (section === "GENERAL") {
      const match = /^[ \t]*Symmetric[ \t]*=[ \t]*([+-]?\d+)[ \t]*(?:\/\/.*)?$/i.exec(text);
      if (match) {
        symmetric = Number(match[1]);
        if (!Number.isSafeInteger(symmetric)) return fail("Unsafe Symmetric integer", lineIndex + 1);
        continue;
      }
    }
    const assignment = /^\s*([A-Za-z0-9_]+Setting)\s*=\s*(.*?)\s*$/.exec(text);
    if (!assignment) { if (/^[ \t]*[A-Za-z0-9_]+Setting\b/.test(text)) return fail("Malformed setting line", lineIndex + 1); continue; }
    const key = assignment[1]!; const valueText = assignment[2]!;
    const valueStart = assignment.index! + assignment[0].indexOf(valueText);
    const commentAt = valueText.indexOf("//");
    const numberRaw = commentAt < 0 ? valueText : valueText.slice(0, commentAt);
    const number = numberRaw.trim();
    if (!/^[+-]?\d+$/.test(number)) return fail(`Malformed integer for ${section}.${key}`, lineIndex + 1);
    const index = Number(number);
    if (!Number.isSafeInteger(index)) return fail(`Unsafe integer for ${section}.${key}`, lineIndex + 1);
    const id = `${section}.${key}`;
    if (settings.has(id)) return fail(`Duplicate setting ${id}`, lineIndex + 1);
    const numberAt = valueText.indexOf(number);
    const base = line.start + prefix;
    const indexStart = base + charOffset(text, valueStart + numberAt, utf8Encoded);
    let display = ""; let displayStart: number | null = null; let displayEnd: number | null = null;
    let markerStart: number | null = null; let markerEnd: number | null = null; let markerDelta = 0;
    if (commentAt >= 0) {
      const labelAt = valueStart + commentAt + 2;
      const suffix = text.slice(labelAt); const marker = MARKER.exec(suffix);
      const labelEnd = marker ? labelAt + marker.index : text.length;
      displayStart = base + charOffset(text, labelAt, utf8Encoded);
      displayEnd = base + charOffset(text, labelEnd, utf8Encoded);
      display = text.slice(labelAt, labelEnd);
      if (marker) {
        markerStart = base + charOffset(text, labelEnd, utf8Encoded); markerEnd = line.contentEnd;
        const magnitude = Number(marker[1]); if (!Number.isSafeInteger(magnitude)) return fail("Unsafe edited marker", lineIndex + 1);
        markerDelta = marker[2] === "up" ? magnitude : -magnitude;
      }
      display = display.trim();
    }
    settings.set(id, { id, section, key, index, display, line: lineIndex + 1, indexStart, indexEnd: indexStart + number.length, displayStart, displayEnd, markerStart, markerEnd, markerDelta });
    if (getSvmFieldDescriptor(id)) recognized++;
  }
  if (!header) return fail("Missing nonempty quoted VehicleClassSetting header", null);
  if (recognized === 0) return fail("No recognized six-page numeric setting found", null);
  const identity = resolveIdentity(header, vehicleComment);
  const document: SvmDocument = { originalBytes: bytes, lines, vehicleClass: header, className: identity.className, carName: identity.carName, carId: identity.carId, identityWarning: identity.warning, symmetric, settings };
  return { ok: true, document };
}
export function svmField(document: SvmDocument, section: string, key: string): SvmSetting | null { return document.settings.get(`${section.toUpperCase()}.${key}`) ?? null; }
function markerText(delta: number): string { const magnitude = Math.abs(delta); return ` (edited, ${magnitude} click${magnitude === 1 ? "" : "s"} ${delta > 0 ? "up" : "down"})`; }
export function writeSVM(document: SvmDocument, edits: readonly SvmEdit[]): Uint8Array {
  const seen = new Set<string>(); const replacements: { start: number; end: number; bytes: Uint8Array }[] = [];
  for (const edit of edits) {
    if (!edit || typeof edit.id !== "string" || !Number.isSafeInteger(edit.delta) || edit.delta === 0) throw new Error("Invalid SVM edit");
    if (seen.has(edit.id)) throw new Error(`Duplicate edit ${edit.id}`); seen.add(edit.id);
    const setting = document.settings.get(edit.id);
    if (!setting || !getSvmFieldDescriptor(edit.id)) throw new Error(`Unknown or unmapped SVM field ${edit.id}`);
    const access = getSvmFieldAccess(document, edit.id); if (!access.editable) throw new Error(access.reason ?? `SVM field ${edit.id} is locked`);
    const result = setting.index + edit.delta; const net = setting.markerDelta + edit.delta;
    if (!Number.isSafeInteger(result) || result < 0 || !Number.isSafeInteger(net)) throw new Error(`Invalid result for ${edit.id}`);
    if (setting.displayStart === null || setting.displayEnd === null) throw new Error(`SVM field ${edit.id} has no display label`);
    const original = document.originalBytes;
    const replaceEnd = setting.markerEnd ?? setting.displayEnd;
    let displayBase = original.subarray(setting.displayStart, setting.displayEnd);
    const isArb = edit.id === "SUSPENSION.FrontAntiSwaySetting" || edit.id === "SUSPENSION.RearAntiSwaySetting";
    const detached = setting.display.trim().toLowerCase() === "detached";
    if (isArb && result === 0) displayBase = encoder.encode("Detached");
    else if (isArb && detached) displayBase = encoder.encode("Connected");
    const marker = net === 0 || (isArb && result === 0) ? new Uint8Array() : encoder.encode(markerText(net));
    const displayOutput = new Uint8Array(displayBase.length + marker.length);
    displayOutput.set(displayBase);
    displayOutput.set(marker, displayBase.length);
    replacements.push({ start: setting.indexStart, end: setting.indexEnd, bytes: encoder.encode(String(result)) });
    replacements.push({ start: setting.displayStart, end: replaceEnd, bytes: displayOutput });
  }
  if (edits.length === 0) return document.originalBytes.slice();
  replacements.sort((a, b) => a.start - b.start);
  for (let i = 1; i < replacements.length; i++) if (replacements[i]!.start < replacements[i - 1]!.end) throw new Error("Overlapping SVM edit spans");
  const output = new Uint8Array(document.originalBytes.length + replacements.reduce((sum, span) => sum + span.bytes.length - (span.end - span.start), 0));
  let source = 0; let target = 0;
  for (const span of replacements) { output.set(document.originalBytes.subarray(source, span.start), target); target += span.start - source; output.set(span.bytes, target); target += span.bytes.length; source = span.end; }
  output.set(document.originalBytes.subarray(source), target);
  return output;
}
export function diffSVM(a: SvmDocument, b: SvmDocument): SvmDiff[] {
  const ids = [...a.settings.keys(), ...[...b.settings.keys()].filter((id) => !a.settings.has(id))]; const result: SvmDiff[] = [];
  for (const id of ids) {
    const before = a.settings.get(id); const after = b.settings.get(id);
    if (before && after && before.index === after.index) continue;
    result.push({ id, kind: before ? after ? "changed" : "removed" : "added", before: before ? { index: before.index, display: before.display } : null, after: after ? { index: after.index, display: after.display } : null });
  }
  return result;
}
