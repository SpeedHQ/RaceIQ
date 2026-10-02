/**
 * Turning a failed `fetch` Response into a useful Error.
 *
 * Deliberately dependency-free — no React, no TanStack Query, no rpc client —
 * so a test can import it without dragging in the whole client module graph.
 * (Importing a React query module into a bun test hangs at module load;
 * see `docs/contributing/test-troubleshooting.md`.)
 */

/**
 * The message for a failed response, without assuming the body is JSON.
 *
 * `res.json()` on an error is a trap: the server answers an unknown /api path
 * with `404 Not Found` as text/plain, so parsing it throws
 * "Unexpected token 'N' ... is not valid JSON" and the real problem — a route
 * that isn't there, usually a server running older code than the UI — is
 * replaced by a parse error that points nowhere.
 */
type ErrorResponse = Pick<Response, "status" | "statusText" | "text">;

export async function errorFromResponse(res: ErrorResponse): Promise<Error> {
  const body = await res.text().catch(() => "");
  if (body.trimStart().startsWith("{")) {
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed?.error === "string" && parsed.error) return new Error(parsed.error);
    } catch {
      /* fall through to the raw body */
    }
  }
  // 404 usually means the server predates this build — say so, since "404 Not
  // Found" alone sends people looking in the wrong place.
  if (res.status === 404) {
    return new Error(`${res.status} ${res.statusText} — endpoint missing; restart the server if it's running older code.`);
  }
  const detail = body.trim().slice(0, 200);
  return new Error(detail ? `${res.status} ${res.statusText}: ${detail}` : `${res.status} ${res.statusText}`);
}
