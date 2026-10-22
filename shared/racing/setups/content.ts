export interface SetupContentRow {
  label: string;
  value: string;
  num?: number;
  min?: number;
  max?: number;
  fixed?: boolean;
  /** Canonical flat setup key. Unmapped/fixed rows remain read-only. */
  knob?: string;
  /** Display value = canonical setting × scale. */
  scale?: number;
  /** Suffix used when displaying an edited value. */
  unit?: string;
  step?: number;
}

/** Catalog capability for one setup control; null means unavailable. */
export type SetupCapabilityRange =
  | { min: number; max: number; step: number }
  | { status: "fixed" }
  | null;

export interface SetupContentSection {
  title: string;
  rows: SetupContentRow[];
}
