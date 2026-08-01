import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const mergeClasses = extendTailwindMerge({
  extend: {
    theme: {
      text: [
        "app-title",
        "app-heading",
        "app-body",
        "app-subtext",
        "app-detail",
        "app-label",
        "app-compact",
        "app-caption",
        "app-micro",
        "app-nano",
        "app-glyph",
        "app-visualization-value",
        "app-visualization-emphasis",
        "app-instrument-value",
        "app-instrument-secondary",
        "app-instrument-primary",
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return mergeClasses(clsx(inputs));
}
