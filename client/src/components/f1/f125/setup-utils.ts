export function setupId(s: { author: string; provider: string; lapTime: string }): string {
  return btoa(`${s.provider}|${s.author}|${s.lapTime}`).replace(/=+$/, "");
}
