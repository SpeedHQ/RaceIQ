export function getYouTubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("youtube.com")) return parsed.searchParams.get("v");
    if (parsed.hostname === "youtu.be") return parsed.pathname.slice(1);
  } catch {
    // Invalid URL.
  }
  return null;
}

export function toYouTubeEmbedUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("youtube.com") && parsed.searchParams.has("v")) {
      return `https://www.youtube.com/embed/${parsed.searchParams.get("v")}`;
    }
    if (parsed.hostname === "youtu.be") return `https://www.youtube.com/embed${parsed.pathname}`;
  } catch {
    // Preserve invalid URLs for iframe consumers, matching previous behavior.
  }
  return url;
}
