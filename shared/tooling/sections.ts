export interface ChangelogEntry {
  version: string;
  date: string;
  notes: string;
  breaking: boolean;
}

export const RELEASE_SECTION_ORDER = ["Breaking", "Features", "Fixes"] as const;
export const RELEASE_HEADING = /^##\s+v([^\s]+)(?:\s+-\s+(\d{4}-\d{2}-\d{2}))?\s*$/gm;
