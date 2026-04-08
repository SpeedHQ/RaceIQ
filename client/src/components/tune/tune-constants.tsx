import React from "react";
import type { TuneCategory } from "@shared/types";

export const CONDITION_COLORS: Record<string, string> = {
  Dry: "bg-amber-500/20 text-amber-400",
  Wet: "bg-cyan-500/20 text-cyan-400",
};

export const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  circuit: (
    <svg
      className="w-3 h-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20M2 12h20" />
    </svg>
  ),
  wet: (
    <svg
      className="w-3 h-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2l-3.5 11a4 4 0 1 0 7 0L12 2z" />
    </svg>
  ),
  "low-drag": (
    <svg
      className="w-3 h-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12h14M12 5l7 7-7 7" />
    </svg>
  ),
  stable: (
    <svg
      className="w-3 h-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 22V2M2 12l10-10 10 10" />
    </svg>
  ),
  "track-specific": (
    <svg
      className="w-3 h-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 1 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  ),
};

export const CATEGORY_LABELS: Record<string, string> = {
  circuit: "Circuit",
  wet: "Wet",
  "low-drag": "Low Drag",
  stable: "Stable",
  "track-specific": "Track Specific",
};

export const CATEGORY_COLORS: Record<string, string> = {
  circuit: "bg-blue-500/20 text-blue-400",
  wet: "bg-cyan-500/20 text-cyan-400",
  "low-drag": "bg-red-500/20 text-red-400",
  stable: "bg-green-500/20 text-green-400",
  "track-specific": "bg-orange-500/20 text-orange-400",
};

export const ALL_CATEGORIES: TuneCategory[] = [
  "circuit",
  "wet",
  "low-drag",
  "stable",
  "track-specific",
];
