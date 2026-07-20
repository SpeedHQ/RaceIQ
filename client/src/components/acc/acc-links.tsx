import { Cloud, Download } from "lucide-react";
import { SiDropbox, SiGoogledrive, SiMega, SiYoutube } from "react-icons/si";

// Shared ACC download-link platform detection / labelling, used by both the
// track-detail setups page and the top-level ACC Setups browser so the
// download button looks identical in both.

export type LinkPlatform = "youtube" | "google-drive" | "onedrive" | "dropbox" | "mega" | "generic";

export function detectPlatform(url: string): LinkPlatform {
  try {
    const h = new URL(url).hostname;
    if (h.includes("youtube.com") || h.includes("youtu.be")) return "youtube";
    if (h.includes("drive.google.com") || h.includes("docs.google.com")) return "google-drive";
    if (h.includes("onedrive.live.com") || h.includes("1drv.ms") || h.includes("sharepoint.com")) return "onedrive";
    if (h.includes("dropbox.com")) return "dropbox";
    if (h.includes("mega.nz") || h.includes("mega.co.nz")) return "mega";
  } catch {}
  return "generic";
}

export function PlatformIcon({ platform, className = "w-3.5 h-3.5" }: { platform: LinkPlatform; className?: string }) {
  if (platform === "youtube") return <SiYoutube className={className} />;
  if (platform === "google-drive") return <SiGoogledrive className={className} />;
  if (platform === "onedrive") return <Cloud className={className} />;
  if (platform === "dropbox") return <SiDropbox className={className} />;
  if (platform === "mega") return <SiMega className={className} />;
  return <Download className={className} />;
}

export const PLATFORM_LABEL: Record<LinkPlatform, string> = {
  youtube: "YouTube",
  "google-drive": "Google Drive",
  onedrive: "OneDrive",
  dropbox: "Dropbox",
  mega: "MEGA",
  generic: "Download",
};
