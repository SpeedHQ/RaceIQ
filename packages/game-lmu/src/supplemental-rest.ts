import { request as httpRequest, type IncomingMessage } from "node:http";
import { LMU_REST_CHANNELS, LMU_FORECAST_NODES, isLmuRestValue, type LmuRestSemanticId } from "@raceiq/shared/telemetry/lmu-rest-channels";
import type { LmuSupplementalObservation } from "@raceiq/shared/telemetry/lmu-supplemental";
import type { ResolutionState } from "@raceiq/shared/telemetry/resolver/contracts";
import { TELEMETRY_CATALOG_HASH, TELEMETRY_CATALOG_VERSION } from "@raceiq/shared/telemetry/catalog/data";

export interface LmuRestIdentity { readonly sessionKey: string; readonly vehicleId: number; }
export interface LmuRestOptions { readonly baseUrl?: string; readonly timeoutMs?: number; readonly now?: () => number; }
const ENDPOINTS = [...new Set(Object.values(LMU_REST_CHANNELS).map((spec) => spec.endpoint))];
const REFERENCE_LIMITATION = "Read-only snapshot; schema supported by TinyPedal source research, not yet verified against a running Windows LMU version.";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function field(value: unknown, ...keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!record(current)) return undefined;
    current = current[key];
  }
  return current;
}

function parseValue(id: LmuRestSemanticId, payload: unknown): unknown {
  switch (id) {
    case "lmu.rest.session.time-scale": return field(payload, "SESSSET_race_timescale", "currentValue");
    case "lmu.rest.session.private-qualifying": {
      const value = field(payload, "SESSSET_private_qual", "currentValue");
      return value === 0 ? false : value === 1 ? true : value;
    }
    case "lmu.rest.garage.setup": return payload;
    case "lmu.rest.garage.steering-lock": {
      const raw = field(payload, "VM_STEER_LOCK", "stringValue");
      if (typeof raw !== "string") return raw;
      const match = /^\s*(\d+(?:\.\d+)?)\s*(?:°|deg(?:rees)?)?\s*$/i.exec(raw);
      return match ? Number(match[1]) : NaN;
    }
    case "lmu.rest.condition.aero": return field(payload, "wearables", "body", "aero");
    case "lmu.rest.condition.brakes":
    case "lmu.rest.condition.suspension": {
      const raw = field(payload, "wearables", id.endsWith("brakes") ? "brakes" : "suspension");
      if (record(raw)) return [raw.FL, raw.FR, raw.RL, raw.RR];
      return raw;
    }
    case "lmu.rest.forecast.practice":
    case "lmu.rest.forecast.qualify":
    case "lmu.rest.forecast.race": {
      const session = id.endsWith("practice") ? "PRACTICE" : id.endsWith("qualify") ? "QUALIFY" : "RACE";
      const nodes: Record<string, unknown> = {};
      for (const node of LMU_FORECAST_NODES) {
        const rain = field(payload, session, node, "WNV_RAIN_CHANCE", "currentValue");
        nodes[node] = {
          sky: field(payload, session, node, "WNV_SKY", "currentValue"),
          temperatureC: field(payload, session, node, "WNV_TEMPERATURE", "currentValue"),
          rainChance: typeof rain === "number" ? rain / 100 : rain,
        };
      }
      return nodes;
    }
    default: return undefined;
  }
}

/** Independent bounded GET tasks; no network work is awaited by native polling. */
export class LmuSupplementalRest {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private identity: LmuRestIdentity | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly controllers = new Map<string, AbortController>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly attemptedAt = new Map<string, number>();
  private readonly observations = new Map<LmuRestSemanticId, LmuSupplementalObservation>();
  private readonly fingerprints = new Map<LmuRestSemanticId, string>();
  private updateSequence = 0n;
  private revisionValue = 0;

  constructor(options: LmuRestOptions = {}) {
    this.baseUrl = new URL(options.baseUrl ?? process.env.LMU_REST_BASE_URL ?? "http://127.0.0.1:6397");
    if (this.baseUrl.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(this.baseUrl.hostname) || this.baseUrl.username || this.baseUrl.password) {
      throw new Error("LMU REST requires an unauthenticated loopback HTTP URL");
    }
    this.timeoutMs = Math.min(10_000, Math.max(100, options.timeoutMs ?? 500));
    this.now = options.now ?? Date.now;
  }

  get revision(): number { return this.revisionValue; }

  activate(identity: LmuRestIdentity): void {
    if (this.identity?.sessionKey === identity.sessionKey && this.identity.vehicleId === identity.vehicleId) return;
    this.stop();
    this.identity = identity;
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, 200);
    this.timer.unref?.();
  }

  /** Acquire due endpoints; callers may await completion without blocking native capture. */
  async refresh(): Promise<void> {
    const identity = this.identity;
    if (!identity) return;
    for (const endpoint of ENDPOINTS) {
      const cadence = endpoint.includes("RepairAndRefuel") || endpoint.includes("pitstop-estimate") ? 1000 : 60_000;
      if (this.pending.has(endpoint) || this.now() - (this.attemptedAt.get(endpoint) ?? -Infinity) < cadence) continue;
      const promise = this.poll(endpoint, identity, this.generation).finally(() => {
        if (this.pending.get(endpoint) === promise) this.pending.delete(endpoint);
      });
      this.pending.set(endpoint, promise);
    }
    await Promise.all(this.pending.values());
  }

  stop(): void {
    this.generation++;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.pending.clear();
    this.identity = null;
    this.observations.clear();
    this.fingerprints.clear();
    this.attemptedAt.clear();
    this.revisionValue++;
  }

  snapshot(): readonly LmuSupplementalObservation[] {
    const now = this.now();
    return [...this.observations.values()].map((entry) => {
      const acquired = entry.acquiredAt;
      const stale = acquired.domain === "wall-clock" && now - acquired.milliseconds > LMU_REST_CHANNELS[entry.semanticId as LmuRestSemanticId].staleAfterMs;
      if (!stale || entry.observation.freshness === "stale") return entry;
      return { ...entry, observation: { ...entry.observation, value: null, state: entry.observation.state === "ok" ? "stale" : entry.observation.state, freshness: "stale", confidence: null } };
    });
  }

  private publish(id: LmuRestSemanticId, identity: LmuRestIdentity, at: number, value: unknown, state: ResolutionState, responseVersion: string | null): void {
    const spec = LMU_REST_CHANNELS[id];
    const previous = this.observations.get(id);
    const fingerprint = state === "ok" ? JSON.stringify(value) : null;
    const changed = fingerprint !== null && fingerprint !== this.fingerprints.get(id);
    const observedAt = changed || !previous ? { domain: "wall-clock" as const, milliseconds: at } : previous.observation.provenance.observedAt;
    if (changed) { this.fingerprints.set(id, fingerprint!); this.updateSequence++; }
    const acquiredAt = state === "error" && previous ? previous.acquiredAt : { domain: "wall-clock" as const, milliseconds: at };
    const limitations = [REFERENCE_LIMITATION];
    if (spec.kind === "condition") limitations.push("Native reported condition; scale and damage/wear interpretation are unverified. Not a percentage.");
    if (spec.kind === "unverified") limitations.push("Physical unit or localized refill format is unverified; measurement is unavailable.");
    this.observations.set(id, {
      semanticId: id, endpoint: spec.endpoint, method: "GET", sessionKey: identity.sessionKey,
      vehicleId: spec.applicability === "session" ? null : identity.vehicleId, applicability: spec.applicability,
      acquiredAt, responseVersion,
      observation: {
        semanticId: id, value: state === "ok" ? value : null, unit: spec.unit,
        mappingStatus: spec.kind === "unverified" ? "unavailable" : "direct", state,
        confidence: null, freshness: "unknown", confidenceComponents: { semanticFidelity: 1, freshness: null, inputCompleteness: state === "ok" ? 1 : 0 },
        provenance: { simulator: "lmu", parserId: "lmu-rest", parserVersion: "1", sourceChannel: spec.endpoint, ...(spec.unit ? { sourceUnit: spec.unit } : {}), resolverVersion: "1", catalogVersion: TELEMETRY_CATALOG_VERSION, catalogHash: TELEMETRY_CATALOG_HASH, observedAt,
          ...(changed ? { sourceObservation: { timestamp: observedAt, updateSequence: this.updateSequence } } : previous?.observation.provenance.sourceObservation ? { sourceObservation: previous.observation.provenance.sourceObservation } : {}),
        }, schemaVersion: "1", limitations,
      },
    });
    this.revisionValue++;
  }

  private async poll(endpoint: string, identity: LmuRestIdentity, generation: number): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(endpoint, controller);
    this.attemptedAt.set(endpoint, this.now());
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const ids = (Object.keys(LMU_REST_CHANNELS) as LmuRestSemanticId[]).filter((id) => LMU_REST_CHANNELS[id].endpoint === endpoint);
    try {
      const { promise, resolve, reject } = Promise.withResolvers<IncomingMessage>();
      const request = httpRequest(new URL(endpoint, this.baseUrl), {
        method: "GET",
      }, resolve).on("error", reject);
      controller.signal.addEventListener("abort", () => {
        request.destroy(controller.signal.reason instanceof Error ? controller.signal.reason : undefined);
      }, { once: true });
      request.end();
      const response = await promise;
      const declaredLength = Number(response.headers["content-length"]);
      if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300 || declaredLength > 1024 * 1024) {
        const error = new Error((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300
          ? `LMU REST HTTP ${response.statusCode}`
          : "LMU REST response exceeds limit");
        response.destroy(error);
        request.destroy(error);
        response.socket?.destroy(error);
        controller.abort(error);
        throw error;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > 1024 * 1024) {
          const error = new Error("LMU REST response exceeds limit");
          response.destroy(error);
          throw error;
        }
        chunks.push(chunk);
      }
      const etag = typeof response.headers.etag === "string" ? response.headers.etag : null;
      let payload: unknown;
      try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch {
        if (generation === this.generation) for (const id of ids) this.publish(id, identity, this.now(), null, "invalid", etag);
        return;
      }
      if (generation !== this.generation || controller.signal.aborted) return;
      for (const id of ids) {
        const spec = LMU_REST_CHANNELS[id];
        const value = parseValue(id, payload);
        const state = spec.kind === "unverified" ? "not-applicable" : value === undefined || value === null ? "missing" : isLmuRestValue(id, value) ? "ok" : "invalid";
        this.publish(id, identity, this.now(), value, state, etag);
      }
    } catch {
      if (generation === this.generation) for (const id of ids) this.publish(id, identity, this.now(), null, "error", null);
    } finally {
      clearTimeout(timeout);
      controller.abort();
      if (this.controllers.get(endpoint) === controller) this.controllers.delete(endpoint);
    }
  }
}
