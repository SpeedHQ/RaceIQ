import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { errorFromResponse } from "../../../client/src/lib/rpc-error";
import { tuneCrudRoutes } from "../../../server/routes/tunes";

/**
 * End-to-end route tests for importing a binary AC EVO `.carsetup`, driven
 * through the real Hono app with the driver's own files.
 *
 * These exist because the unit tests around `carSlugFromPresetId` and the
 * base64 round-trip all passed while the actual import still failed with
 * "unexpected token ... invalid JSON" — the bug was in the request/response
 * plumbing, which only a real request exercises.
 *
 * Fixtures are the two files that reproduced it: `mustang.carsetup` (carries a
 * preset id) and `Tourist.carsetup` (decodes fine but has NO preset id, so no
 * car can be read from it).
 */

const FIXTURES = resolve(import.meta.dir, "..", "..", "artifacts/carsetup");
const read = (name: string) => readFileSync(resolve(FIXTURES, name));

async function inspect(bytes: Buffer) {
  return await tuneCrudRoutes.request("/api/tunes/inspect-carsetup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contentBase64: bytes.toString("base64") }),
  });
}

describe("POST /api/tunes/inspect-carsetup", () => {
  test("mustang.carsetup — reads the car out of the preset id", async () => {
    const res = await inspect(read("mustang.carsetup"));
    expect(res.status).toBe(200);
    // Parse as text first: an HTML error page here is exactly the
    // "unexpected token" the driver saw, and res.json() would obscure it.
    const body = await res.text();
    expect(body.startsWith("{"), `expected JSON, got: ${body.slice(0, 120)}`).toBe(true);

    const json = JSON.parse(body);
    expect(json.carModel).toBe("ford_mustang_gt3");
    expect(json.carName).toBe("Ford Mustang GT3");
    expect(json.knownCar).toBe(true);
  });

  test("Tourist.carsetup — decodes, but states no car", async () => {
    const res = await inspect(read("Tourist.carsetup"));
    // Must be a clean 200 with nulls, NOT an error: the file is perfectly
    // valid, it just doesn't identify its car. Failing here would push the
    // driver into an error state for a file they can legitimately import.
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.startsWith("{"), `expected JSON, got: ${body.slice(0, 120)}`).toBe(true);

    const json = JSON.parse(body);
    expect(json.presetId).toBeNull();
    expect(json.carModel).toBeNull();
    expect(json.knownCar).toBe(false);
  });

  test("a non-setup body is rejected as JSON, not as an HTML error page", async () => {
    const res = await inspect(Buffer.from("definitely not a carsetup", "utf-8"));
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body.startsWith("{"), `expected JSON, got: ${body.slice(0, 120)}`).toBe(true);
    expect(JSON.parse(body).error).toBeTruthy();
  });

  test("every response is application/json so the client can parse it", async () => {
    for (const name of ["mustang.carsetup", "Tourist.carsetup"]) {
      const res = await inspect(read(name));
      expect(res.headers.get("content-type") ?? "", name).toContain("application/json");
    }
  });
});

describe("POST /api/tunes/place-setup — payload validation", () => {
  /** The schema demands exactly one of content / contentBase64. */
  async function place(body: unknown) {
    return await tuneCrudRoutes.request("/api/tunes/place-setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("rejects a .carsetup sent as JSON content", async () => {
    const res = await place({
      gameId: "ac-evo",
      carName: "ford_mustang_gt3",
      trackName: "spa",
      fileName: "mustang.carsetup",
      content: { not: "a real setup" },
    });
    // 400 either way; the point is a structured JSON error rather than a crash.
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.text();
    expect(body.startsWith("{"), `expected JSON, got: ${body.slice(0, 120)}`).toBe(true);
  });

  test("rejects both content and contentBase64 at once", async () => {
    const res = await place({
      gameId: "ac-evo",
      carName: "ford_mustang_gt3",
      trackName: "spa",
      fileName: "mustang.carsetup",
      content: { a: 1 },
      contentBase64: read("mustang.carsetup").toString("base64"),
    });
    expect(res.status).toBe(400);
  });

  test("rejects neither", async () => {
    const res = await place({
      gameId: "ac-evo",
      carName: "ford_mustang_gt3",
      trackName: "spa",
      fileName: "mustang.carsetup",
    });
    expect(res.status).toBe(400);
  });
});

/**
 * The client-side half of the "unexpected token ... is not valid JSON" bug.
 *
 * The server answers an unknown /api path with `404 Not Found` as text/plain.
 * The hooks used to call `res.json()` on any non-ok response, so a route the
 * running server didn't have yet surfaced as a JSON parse error pointing at
 * nothing — instead of "that endpoint isn't there". `errorFromResponse` reads
 * the body as text first and only parses when it actually looks like JSON.
 */
describe("errorFromResponse", () => {
  test("a plain-text 404 does not throw a parse error", async () => {
    const res = new Response("404 Not Found", { status: 404, statusText: "Not Found" });
    const err = await errorFromResponse(res);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("404");
    // The actionable part: says the endpoint is missing, not "unexpected token".
    expect(err.message.toLowerCase()).toContain("endpoint missing");
    expect(err.message.toLowerCase()).not.toContain("unexpected token");
  });

  test("a JSON error body still yields the server's own message", async () => {
    const res = new Response(JSON.stringify({ error: "Couldn't decode that .carsetup file" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
    expect((await errorFromResponse(res)).message).toBe("Couldn't decode that .carsetup file");
  });

  test("an HTML error page degrades to status + snippet, never a parse throw", async () => {
    const res = new Response("<!DOCTYPE html><html><body>nope</body></html>", { status: 500, statusText: "Internal Server Error" });
    const err = await errorFromResponse(res);
    expect(err.message).toContain("500");
    expect(err.message.toLowerCase()).not.toContain("unexpected token");
  });

  test("an empty body yields status text alone", async () => {
    const err = await errorFromResponse(new Response("", { status: 502, statusText: "Bad Gateway" }));
    expect(err.message).toBe("502 Bad Gateway");
  });
});

/**
 * The same base setup is routinely run at several circuits, so importing a file
 * that already exists under one track must still be allowed for another.
 *
 * Setups are keyed by path (Setups/<car>/<track>/<file>), so two tracks are two
 * distinct targets — the server was never the thing blocking this. The bug was
 * client-side: a filename match pinned the existing track and returned early,
 * discarding the payload so the file could never be placed elsewhere.
 */
describe("place-setup: the same file under a second track", () => {
  const tmp = resolve(import.meta.dir, "..", "..", "artifacts/.place-setup-tmp");

  test("writing the same file to two tracks yields two independent copies", () => {
    const bytes = read("mustang.carsetup");
    const spa = resolve(tmp, "ford_mustang_gt3", "spa", "mustang.carsetup");
    const monza = resolve(tmp, "ford_mustang_gt3", "monza", "mustang.carsetup");

    rmSync(tmp, { recursive: true, force: true });
    for (const target of [spa, monza]) {
      mkdirSync(resolve(target, ".."), { recursive: true });
      writeFileSync(target, bytes);
    }

    // Distinct paths, so neither overwrites the other …
    expect(spa).not.toBe(monza);
    expect(existsSync(spa)).toBe(true);
    expect(existsSync(monza)).toBe(true);
    // … and both are byte-identical to the source, which is what makes the
    // second import a real usable base rather than a stub.
    expect(readFileSync(spa).equals(bytes)).toBe(true);
    expect(readFileSync(monza).equals(bytes)).toBe(true);

    rmSync(tmp, { recursive: true, force: true });
  });
});
