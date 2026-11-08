/** Hostname only: no scheme, path, credentials or port. Empty means automatic LAN selection. */
export function normalizeHudHostname(value: string): string | null {
  const hostname = value.trim().toLowerCase();
  if (!hostname) return "";
  if (hostname.length > 253) return null;
  return hostname.split(".").every(label => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) ? hostname : null;
}

/** One URL builder shared by the displayed link and QR code. */
export function hudUrl(hostname: string | undefined, port: string | number | undefined, path = ""): string | null {
  return hostname && port ? `http://${hostname}:${port}${path}` : null;
}
