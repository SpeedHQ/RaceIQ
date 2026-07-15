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
