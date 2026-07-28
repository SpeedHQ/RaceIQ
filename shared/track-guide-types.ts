/**
 * Shape of an expert track guide once resolved against track meta.
 *
 * Lives in shared/ because the client renders it on the track Info page while
 * the server builds it — the server module itself reads from disk, so the
 * client can't import it just for the type.
 */
export interface ResolvedTrackGuideCorner {
  /** Meta's label for the corner ("Piscine (14-15)"), not the guide's own name. */
  label: string;
  type: string;
  technique: string;
  trap: string;
  /** Official turn numbers, when the entry is anchored. */
  numbers?: number[];
  /** One of the guide's priority corners for lap time. */
  priority: boolean;
}

export interface ResolvedTrackGuide {
  id: string;
  character: string;
  corners: ResolvedTrackGuideCorner[];
}

/**
 * On-disk shape of shared/tracks/guides/<slug>.json — the authored source the
 * Resolved* types above are built from.
 *
 * Everything except `key` and `numbers` is English prose destined for
 * translation, which is the whole reason this is a file rather than a TS
 * literal: a translator can overlay it without touching code.
 */
export interface TrackGuideCornerFile {
  /**
   * Stable, locale-independent, unique within the file. The join key for
   * `priorityCorners` and for a future `guides-<locale>/` overlay.
   *
   * Generated once from the English `name` and then committed — never re-derived
   * at runtime, or translating `name` would silently break every join.
   */
  key: string;
  /** English label. Prose fallback when meta has no name for the turn. */
  name: string;
  /** Official turn numbers — the join key into shared/tracks/meta/<slug>.json. */
  numbers?: number[];
  type: string;
  technique: string;
  trap: string;
}

export interface TrackGuideFile {
  /** Must equal the filename stem. */
  id: string;
  /**
   * Literal "en" today: these files are the base locale by definition.
   * Widened when guides-<locale>/ overlays land.
   */
  locale: "en";
  character: string;
  corners: TrackGuideCornerFile[];
  /**
   * Corner *keys*, not names. Declaration order is meaningful — the prompt
   * prints it verbatim.
   */
  priorityCorners: string[];
  /** Provenance for the curated prose. Not shown to the model. */
  sources?: string;
  notes?: string;
}
