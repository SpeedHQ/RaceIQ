import { createFileRoute } from "@tanstack/react-router";
import React, { useEffect, useRef, useState } from "react";
import { RawTelemetry } from "../../components/RawTelemetry";
import { useTelemetryStore } from "../../stores/telemetry";

type PageKey = "physics" | "graphics" | "staticData";

interface HexResp {
  physics: string;
  graphics: string;
  staticData: string;
  ts: number;
}

interface ParsedResp {
  sizes: { physics: number; graphics: number; staticData: number };
  physics: Record<string, number | string>;
  graphics: Record<string, number | string>;
  static_v06: Record<string, number | string>;
  static_legacy_wchar: Record<string, string>;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function HexViewer({ bytes, prev, page }: { bytes: Uint8Array; prev: Uint8Array | null; page: PageKey }) {
  const rows: React.ReactElement[] = [];
  const rowSize = 16;
  for (let i = 0; i < bytes.length; i += rowSize) {
    const cells: React.ReactElement[] = [];
    for (let j = 0; j < rowSize; j++) {
      const idx = i + j;
      if (idx >= bytes.length) {
        cells.push(<span key={j} className="inline-block w-6" />);
        continue;
      }
      const b = bytes[idx];
      const pb = prev ? prev[idx] : b;
      const changed = prev && b !== pb;
      const nonZero = b !== 0;
      let cls = "inline-block w-6 text-center tabular-nums ";
      if (changed) cls += "bg-yellow-500/40 text-yellow-100";
      else if (nonZero) cls += "text-green-400";
      else cls += "text-app-text-muted/30";
      cells.push(
        <span key={j} className={cls}>
          {b.toString(16).padStart(2, "0")}
        </span>,
      );
    }
    // ASCII column
    const asciiChars: React.ReactElement[] = [];
    for (let j = 0; j < rowSize; j++) {
      const idx = i + j;
      if (idx >= bytes.length) break;
      const b = bytes[idx];
      const ch = b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".";
      asciiChars.push(
        <span key={j} className={b !== 0 ? "text-green-400" : "text-app-text-muted/30"}>
          {ch}
        </span>,
      );
    }
    rows.push(
      <div key={i} className="font-mono text-xs whitespace-pre">
        <span className="text-app-text-muted mr-2">{i.toString(16).padStart(4, "0")}</span>
        {cells}
        <span className="ml-2">{asciiChars}</span>
      </div>,
    );
  }
  const nonZeroCount = Array.from(bytes).filter((b) => b !== 0).length;
  const changedCount = prev ? Array.from(bytes).filter((b, i) => b !== prev[i]).length : 0;
  return (
    <div>
      <div className="text-xs text-app-text-muted mb-2">
        {page}: {bytes.length} bytes — {nonZeroCount} non-zero, {changedCount} changed since last poll
      </div>
      <div className="overflow-auto max-h-[60vh] border border-app-border rounded bg-black/40 p-2">
        {rows}
      </div>
    </div>
  );
}

interface VerifyRow { field: string; offset: number; type: string; hex: string; value: number | string }
interface VerifyResp { physics: VerifyRow[]; graphics: VerifyRow[]; static: VerifyRow[] }

function RawPage() {
  const { packet } = useTelemetryStore();
  const [view, setView] = useState<"parsed" | "hex" | "fields" | "verify">("parsed");
  const [page, setPage] = useState<PageKey>("graphics");
  const [hex, setHex] = useState<{ physics: Uint8Array; graphics: Uint8Array; staticData: Uint8Array } | null>(null);
  const [parsed, setParsed] = useState<ParsedResp | null>(null);
  const [verify, setVerify] = useState<VerifyResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lastPollAt, setLastPollAt] = useState<number | null>(null);
  const [pollCount, setPollCount] = useState(0);
  const [, forceTick] = useState(0);
  const prevRef = useRef<{ physics: Uint8Array; graphics: Uint8Array; staticData: Uint8Array } | null>(null);

  // Re-render every second so "Xms ago" updates even when no new poll fires
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (view === "parsed") return;
    let cancelled = false;
    const tick = async () => {
      try {
        if (view === "hex") {
          const r = await fetch("/api/ac-evo/debug/hex");
          if (!r.ok) throw new Error(`${r.status}`);
          const j = (await r.json()) as HexResp;
          if (cancelled) return;
          prevRef.current = hex;
          setHex({
            physics: base64ToBytes(j.physics),
            graphics: base64ToBytes(j.graphics),
            staticData: base64ToBytes(j.staticData),
          });
        } else if (view === "verify") {
          const r = await fetch("/api/ac-evo/debug/verify");
          if (!r.ok) throw new Error(`${r.status}`);
          const j = (await r.json()) as VerifyResp;
          if (cancelled) return;
          setVerify(j);
        } else {
          const r = await fetch("/api/ac-evo/debug/raw");
          if (!r.ok) throw new Error(`${r.status}`);
          const j = (await r.json()) as ParsedResp;
          if (cancelled) return;
          setParsed(j);
        }
        if (cancelled) return;
        setLastPollAt(Date.now());
        setPollCount((n) => n + 1);
        setErr(null);
      } catch (e) {
        if (!cancelled) setErr(String(e));
      }
    };
    tick();
    const interval = setInterval(tick, 500);
    return () => { cancelled = true; clearInterval(interval); };
  }, [view, hex]);

  const pollAgeMs = lastPollAt ? Date.now() - lastPollAt : null;

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <div className="flex gap-2 p-2 border-b border-app-border items-center">
        <button
          className={`px-3 py-1 rounded text-xs ${view === "parsed" ? "bg-app-accent text-white" : "bg-app-surface"}`}
          onClick={() => setView("parsed")}
        >
          Parsed Packet
        </button>
        <button
          className={`px-3 py-1 rounded text-xs ${view === "fields" ? "bg-app-accent text-white" : "bg-app-surface"}`}
          onClick={() => setView("fields")}
        >
          Struct Fields (v0.6)
        </button>
        <button
          className={`px-3 py-1 rounded text-xs ${view === "verify" ? "bg-app-accent text-white" : "bg-app-surface"}`}
          onClick={() => setView("verify")}
        >
          Verify (bytes + interp)
        </button>
        <button
          className={`px-3 py-1 rounded text-xs ${view === "hex" ? "bg-app-accent text-white" : "bg-app-surface"}`}
          onClick={() => setView("hex")}
        >
          Raw Hex
        </button>
        {view === "hex" && (
          <div className="flex gap-1 ml-4">
            {(["physics", "graphics", "staticData"] as PageKey[]).map((p) => (
              <button
                key={p}
                className={`px-2 py-1 rounded text-xs ${page === p ? "bg-app-surface-hover" : "bg-app-surface"}`}
                onClick={() => setPage(p)}
              >
                {p}
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto text-xs text-app-text-muted font-mono">
          {view === "parsed"
            ? "source: WebSocket (live)"
            : lastPollAt == null
              ? "no poll yet"
              : `polls: ${pollCount} · last ${pollAgeMs}ms ago (${new Date(lastPollAt).toLocaleTimeString()})`}
        </div>
      </div>
      {err && <div className="p-2 text-red-400 text-xs">Error: {err}</div>}
      {view === "parsed" && (
        <div className="flex-1 overflow-hidden">
          <RawTelemetry packet={packet} />
        </div>
      )}
      {view === "fields" && parsed && (
        <div className="flex-1 overflow-auto p-4 text-xs">
          <div className="mb-2 text-app-text-muted">
            Page sizes: physics {parsed.sizes.physics}B, graphics {parsed.sizes.graphics}B, static {parsed.sizes.staticData}B
          </div>
          <FieldTable title="static_legacy_wchar (ACC-style read for comparison)" obj={parsed.static_legacy_wchar} />
          <FieldTable title="static (v0.6 layout)" obj={parsed.static_v06} />
          <FieldTable title="graphics (v0.6 SPageFileGraphicEvo)" obj={parsed.graphics} />
          <FieldTable title="physics (SPageFilePhysics)" obj={parsed.physics} />
        </div>
      )}
      {view === "hex" && hex && (
        <div className="flex-1 overflow-auto p-4">
          <HexViewer bytes={hex[page]} prev={prevRef.current?.[page] ?? null} page={page} />
        </div>
      )}
      {view === "verify" && verify && (
        <div className="flex-1 overflow-auto p-4 text-xs">
          <div className="mb-3 text-app-text-muted">
            Every field: our expected offset + raw hex bytes at that offset + interpreted value.
            If you see non-zero hex but zero interpretation, that's a wrong offset/type.
          </div>
          <VerifyTable title="graphics (SPageFileGraphicEvo, v0.6)" rows={verify.graphics} />
          <VerifyTable title="static (SPageFileStaticEvo, v0.6)" rows={verify.static} />
          <VerifyTable title="physics (SPageFilePhysics)" rows={verify.physics} />
        </div>
      )}
    </div>
  );
}

function VerifyTable({ title, rows }: { title: string; rows: VerifyRow[] }) {
  return (
    <div className="mb-6">
      <div className="text-sm font-semibold mb-2">{title}</div>
      <div className="font-mono text-xs">
        <div className="grid grid-cols-[50px_1fr_60px_220px_1fr] gap-x-2 py-1 border-b border-app-border text-app-text-muted uppercase">
          <span>off</span>
          <span>field</span>
          <span>type</span>
          <span>hex</span>
          <span>interpretation</span>
        </div>
        {rows.map((r) => {
          const hexNonZero = r.hex.replace(/\s|00/g, "").length > 0;
          const valueZero = typeof r.value === "number" ? r.value === 0 : r.value === "";
          const mismatch = hexNonZero && valueZero;
          return (
            <div
              key={`${r.offset}-${r.field}`}
              className={`grid grid-cols-[50px_1fr_60px_220px_1fr] gap-x-2 py-0.5 border-b border-app-border/30 ${mismatch ? "bg-red-900/30" : ""}`}
            >
              <span className="text-app-text-muted">{r.offset}</span>
              <span className="text-app-text-secondary truncate">{r.field}</span>
              <span className="text-app-text-muted">{r.type}</span>
              <span className={hexNonZero ? "text-green-400" : "text-app-text-muted/50"}>{r.hex || "—"}</span>
              <span className={valueZero ? "text-app-text-muted/50" : "text-app-text"}>
                {typeof r.value === "number"
                  ? Number.isInteger(r.value) ? r.value : r.value.toFixed(3)
                  : `"${r.value}"`}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FieldTable({ title, obj }: { title: string; obj: Record<string, unknown> }) {
  const entries = Object.entries(obj);
  return (
    <div className="mb-4">
      <div className="text-sm font-semibold mb-1">{title}</div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono">
        {entries.map(([k, v]) => (
          <div key={k} className="flex justify-between border-b border-app-border/30 py-0.5">
            <span className="text-app-text-secondary">{k}</span>
            <span className={typeof v === "number" && v === 0 ? "text-app-text-muted/50" : "text-app-text"}>
              {typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(3)) : `"${String(v)}"`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/ac-evo/raw")({
  component: RawPage,
});
