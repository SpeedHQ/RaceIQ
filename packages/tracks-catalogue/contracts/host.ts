import type { ComponentType, ComponentProps, ReactNode } from "react";
import type { Button as BaseButton } from "@base-ui/react/button";
import type { Tabs as BaseTabs } from "@base-ui/react/tabs";
import type { GameId } from "@raceiq/shared/games/ids";
import type { ResolvedTrackGuide } from "@raceiq/shared/racing/tracks/guide/types";
import type { TuneSettings } from "@raceiq/shared/racing/tuning/types";
import type { Point, TrackInfo, TrackSectors, TrackSegment, TrackBoundaries } from "./types";
import type { TrackLap } from "./laps";
import type { CalibrationComparison } from "./calibration";

export interface PitLine { kind: "pit-road" | "merge-line"; points: Point[] }
export type TrackOutline = { points?: Point[]; pitLines?: PitLine[]; flipX?: boolean } | Point[];
export interface SectorBounds { s1End: number; s2End: number }
export type SourcedTrackSectors = TrackSectors & { source?: string };
export interface F125TrackCounts { trackId: string; setupCount: number; guideCount: number; guideUrl: string }
export type AccSetupCounts = Record<string, number>;
/** Consumed projection of the community catalogue; settings retain their domain type. */
export interface CatalogueTune {
  id: string;
  name: string;
  carId: string;
  category: "circuit" | "wet" | "low-drag" | "stable" | "track-specific";
  trackId?: string;
  bestTracks?: string[];
  description: string;
  settings: TuneSettings;
  sourceName: string;
}
/** User settings are opaque persisted JSON, as in the existing tune browser. */
export interface CatalogueUserTune {
  id: number;
  name: string;
  carId: string;
  category: string;
  trackId: string | null;
  description: string;
  settings: unknown;
}
export interface CatalogueLapTime { track: string; car: string; driver: string; carClass: string; laptime: string }
export interface QueryValue<T> { data: T | undefined; isLoading: boolean }
export interface ResolvedCatalogueNames { trackNames: Record<string, string>; carNames: Record<string, string> }
export interface TrackMatchTune { trackId?: string | null; bestTracks?: string[] }
export interface TrackMatchTarget { id: string; name: string; variant: string }
export interface CatalogueNavigation {
  to: string;
  replace?: boolean;
  search?: { track: string; lapA: number; lapB: number; carA?: string; carB?: string };
}
export type CatalogueNavigate = (options: CatalogueNavigation) => void | Promise<void>;
export interface SearchOption<K extends string | number> { key: K; label: string; search?: string }
export interface SearchMultiSelectProps<K extends string | number> {
  buttonLabel: string;
  options: SearchOption<K>[];
  isSelected: (key: K) => boolean;
  onSelect: (key: K) => void;
  onClear?: () => void;
  mode?: "single" | "multi";
  searchPlaceholder?: string;
  renderItem?: (option: SearchOption<K>, selected: boolean) => ReactNode;
  className?: string;
  menuWidthClass?: string;
  menuAlign?: "left" | "right";
}
export interface SearchSelectOption { value: string; label: string; group?: string; disabled?: boolean }
export interface SearchSelectProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: SearchSelectOption[];
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  fallbackLabel?: string;
}
export type CatalogueTabsProps = Omit<BaseTabs.Root.Props, "value" | "defaultValue" | "onValueChange"> & {
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (value: string, details: BaseTabs.Root.ChangeEventDetails) => void;
};
export type CatalogueTabsListProps = BaseTabs.List.Props & { variant?: "default" | "pills" | "underline" };
export type CatalogueTabsTriggerProps = Omit<BaseTabs.Tab.Props, "value"> & { value: string; variant?: "default" | "pills" | "underline" };
export type CatalogueTabsContentProps = Omit<BaseTabs.Panel.Props, "value"> & { value: string };
export type CatalogueButtonProps = BaseButton.Props & {
  variant?: "plain" | "app-ghost" | "app-primary";
  size?: "content" | "app-sm";
};
export type CatalogueTableProps = ComponentProps<"table"> & { containerClassName?: string };
export type CatalogueSortableHeadProps = Omit<ComponentProps<"th">, "onClick" | "aria-sort"> & {
  direction?: "ascending" | "descending";
  onSort: () => void;
};

export type TracksCatalogueSimpleMessage =
  | "trackviewer_loading" | "trackviewer_search_placeholder" | "trackviewer_sort_label" | "label_laps"
  | "trackviewer_with_outlines" | "trackviewer_without_outlines_suffix" | "trackviewer_no_tracks_matching" | "trackviewer_without_outlines_title"
  | "trackcard_lap_singular" | "pitwindow_laps" | "trackcard_no_outline" | "trackcard_setup_count" | "trackcard_setup_counts" | "trackcard_guide_count" | "trackcard_guide_counts"
  | "trackdetailroute_not_found" | "track_detail_race" | "track_detail_quali" | "common_back" | "track_detail_info_tab" | "track_detail_guides_tab" | "track_detail_setup_tab" | "trackdetail_debug_tab"
  | "trackinfo_source_curated" | "trackinfo_source_auto" | "trackinfo_length" | "trackinfo_turns" | "trackinfo_official_layout_data" | "trackinfo_pit_speed" | "trackinfo_max_cars" | "trackinfo_straights" | "trackinfo_rain_racing" | "trackinfo_night_racing"
  | "trackdetail_sector_boundaries" | "trackinfo_no_named_corners" | "trackdetail_no_sector_data" | "trackinfo_guide" | "trackinfo_priority" | "trackinfo_trap" | "track_detail_segments"
  | "trackinfo_col_section" | "trackinfo_col_type" | "trackinfo_col_direction" | "trackinfo_col_sector" | "trackinfo_col_lap_position" | "trackinfo_type_corner" | "trackinfo_type_straight" | "trackinfo_dir_left" | "trackinfo_dir_right" | "trackinfo_no_segments" | "trackdetail_no_outline_available"
  | "track_map_loading" | "track_map_zoom_in" | "track_map_zoom_out" | "track_map_reset_view" | "track_map_racing_line" | "track_map_left_edge" | "track_map_right_edge" | "track_map_pit_lane" | "track_map_start_finish" | "track_map_pit" | "track_map_garage"
  | "leaderboard_no_data" | "communityleaderboard_car" | "communityleaderboard_driver" | "communityleaderboard_time"
  | "tune_category_circuit" | "tune_category_wet" | "tune_category_low_drag" | "tune_category_stable" | "tune_category_track_specific" | "catalogtracksetups_setups"
  | "tune_section_tires" | "tune_field_front_pressure" | "tune_field_rear_pressure" | "accsetup_compound" | "tune_section_gearing" | "tune_field_final_drive" | "tune_field_top_speed"
  | "tune_section_alignment" | "f1setup_field_f_camber" | "f1setup_field_r_camber" | "f1setup_field_f_toe" | "f1setup_field_r_toe" | "tune_field_front_caster" | "tune_section_anti_roll_bars" | "tune_position_front" | "tune_position_rear"
  | "tune_section_springs" | "tune_field_front_rate" | "tune_field_rear_rate" | "f1setup_field_f_height" | "f1setup_field_r_height" | "tune_section_damping" | "tune_field_front_rebound" | "tune_field_rear_rebound" | "tune_field_front_bump" | "tune_field_rear_bump"
  | "tune_section_aero" | "tune_field_front_downforce" | "tune_field_rear_downforce" | "tune_section_differential" | "tune_field_rear_accel" | "tune_field_rear_decel" | "tune_field_front_accel" | "tune_field_front_decel" | "tune_field_center_differential" | "tune_section_brakes" | "tune_field_brake_balance" | "tune_field_brake_pressure"
  | "catalogtracksetups_community" | "catalogtracksetups_yours" | "catalogtracksetups_no_setups_yet" | "catalog_search_cars_placeholder" | "catalog_filter_all_cars" | "catalogtracksetups_name_car" | "catalogtracksetups_category_short"
  | "common_edit" | "common_save" | "common_cancel" | "trackdetail_segment_name_readonly" | "trackdetail_split_segment" | "trackdetail_remove_segment" | "trackdetail_s1_end" | "trackdetail_s2_end" | "trackdetail_s3_end" | "trackdetail_finish"
  | "trackdetail_zoom_in" | "trackdetail_zoom_out" | "trackdetail_reset_zoom" | "track_detail_show_segments" | "track_detail_show_sectors" | "overlay_sectors" | "overlay_segments"
  | "track_detail_stats" | "track_detail_last_100" | "track_detail_no_laps_recorded" | "trackdetail_recent_label" | "label_best" | "track_detail_median" | "track_detail_worst" | "track_detail_typical_range" | "trackdetail_trend" | "trackdetail_faster" | "trackdetail_slower" | "trackdetail_keeping_pace" | "trackdetail_worst_point" | "trackdetail_best_point" | "trackdetail_older"
  | "trackdetail_sectors" | "trackdetail_theoretical_best_tooltip" | "recap_theoretical_best" | "label_delta" | "trackdetail_most_variance_tooltip" | "trackdetail_by_car" | "trackdetail_by_lap_num" | "leaderboard_community"
  | "trackdetail_selected" | "trackdetail_compare" | "trackdetail_delete" | "trackdetail_confirm" | "trackdetail_yes" | "trackdetail_all_divisions" | "trackdetail_search_divisions_placeholder" | "track_detail_all_cars" | "label_cars" | "label_car" | "trackdetail_search_cars_placeholder" | "trackdetail_stats_page" | "track_detail_no_laps_match_filters" | "trackdetail_invalid_lap"
  | "online_community_laps_car" | "online_community_laps_select_car" | "online_community_laps_no_cars" | "online_community_laps_title"
  | "track_detail_class" | "label_type" | "track_detail_lap_num" | "label_time" | "sessions_col_date" | "sessions_col_notes" | "sessions_replay_lap"
  | "trackdebugpanel_loading" | "trackdebugpanel_lmu_geometry" | "trackdebugpanel_outline" | "trackdebugpanel_points" | "trackdebugpanel_boundaries" | "trackdebugpanel_available" | "curbdebug_no" | "trackdebugpanel_left_edge_pts" | "trackdebugpanel_right_edge_pts" | "trackdebugpanel_coord_system" | "trackdebugpanel_pit_lane" | "trackdebugpanel_none" | "trackdebugpanel_legend_center" | "trackdebugpanel_left_edge" | "trackdebugpanel_right_edge"
  | "trackcalibration_title" | "trackcalibration_unavailable" | "trackcalibration_current" | "trackcalibration_not_calibrated" | "trackcalibration_show_history";
export type TracksCatalogueMessages = { [K in TracksCatalogueSimpleMessage]: () => string } & {
  trackdetail_map_alt: (input: { track: string; variant: string }) => string;
  trackinfo_sections: (input: { n: string }) => string;
  trackinfo_pit_stalls: (input: { n: string }) => string;
  trackcalibration_fit_lap: (input: { sequence: number; lapNumber: number }) => string;
  trackcalibration_rmse_unavailable: (input: { points: number }) => string;
  trackcalibration_rmse: (input: { rmse: string; points: number }) => string;
  trackcalibration_no_history: (input: { points: number }) => string;
};

export interface TracksCatalogueOperations {
  f125Tracks: () => Promise<F125TrackCounts[]>;
  accSetupCounts: () => Promise<AccSetupCounts>;
  outline: (id: string, gameId?: GameId) => Promise<TrackOutline>;
  sectors: (id: string, gameId?: GameId) => Promise<SourcedTrackSectors | null>;
  sectorBounds: (id: string, gameId?: GameId) => Promise<SectorBounds | null>;
  laps: (id: string, gameId?: GameId) => Promise<TrackLap[] | null>;
  guide: (id: string, gameId?: GameId) => Promise<ResolvedTrackGuide | null>;
  saveSegments: (id: string, gameId: GameId | undefined, segments: TrackSegment[]) => Promise<{ ok: boolean }>;
  saveSectorBounds: (id: string, gameId: GameId | undefined, bounds: SectorBounds) => Promise<{ ok: boolean }>;
  boundaries: (id: string, gameId?: GameId) => Promise<TrackBoundaries | null>;
  calibrationComparison: (id: string) => Promise<CalibrationComparison | null>;
}

export interface TracksCatalogueHost {
  m: TracksCatalogueMessages;
  AppInput: ComponentType<ComponentProps<"input">>;
  Button: ComponentType<CatalogueButtonProps>;
  Card: ComponentType<ComponentProps<"div">>;
  Tabs: ComponentType<CatalogueTabsProps>;
  TabsList: ComponentType<CatalogueTabsListProps>;
  TabsTrigger: ComponentType<CatalogueTabsTriggerProps>;
  TabsContent: ComponentType<CatalogueTabsContentProps>;
  Table: ComponentType<CatalogueTableProps>;
  TableBody: ComponentType<ComponentProps<"tbody">>;
  TableCell: ComponentType<ComponentProps<"td">>;
  TableHead: ComponentType<ComponentProps<"th">>;
  TableHeader: ComponentType<ComponentProps<"thead">>;
  TableRow: ComponentType<ComponentProps<"tr">>;
  SortableTableHead: ComponentType<CatalogueSortableHeadProps>;
  InfoTooltip: ComponentType<{ children: ReactNode; position?: "top" | "bottom"; width?: "max" | "xs" | "sm" | "md" }>;
  SearchSelect: ComponentType<SearchSelectProps>;
  SearchMultiSelect: <K extends string | number>(props: SearchMultiSelectProps<K>) => ReactNode;
  SetupSettingsPanel: ComponentType<{ gameId: GameId; settings: Record<string, unknown> }>;
  AccTrackGuide: ComponentType<{ trackId: string; trackName: string }>;
  AccTrackSetups: ComponentType<{ trackId: string }>;
  F125TrackGuide: ComponentType<{ trackId: string }>;
  F125SetupsWithGuide: ComponentType<{ trackId: string; trackName: string }>;
  F125Leaderboard: ComponentType<{ trackId: string }>;
  OnlineCommunityLaps: ComponentType<{ gameId: string | null; trackId: string | null; carId: string | null }>;
  useTracks: () => QueryValue<TrackInfo[]>;
  useCatalogTunes: () => QueryValue<CatalogueTune[]>;
  useUserTunes: (gameId?: GameId) => QueryValue<CatalogueUserTune[]>;
  useLaptimes: () => QueryValue<CatalogueLapTime[]>;
  useResolveNames: (trackIds: string[], carIds: string[]) => { data: ResolvedCatalogueNames | undefined };
  useBulkDeleteLaps: () => { mutateAsync: (ids: number[]) => Promise<void> };
  useGameId: () => GameId | null;
  useUnits: (gameId?: GameId) => { fromMph: (value: number) => number; speedLabel: string };
  useNavigate: () => CatalogueNavigate;
  useParams: (options: { strict: false }) => { trackId?: string };
  useSetupSearch: () => { setup?: string };
  useSelectSetup: () => (id: string) => void;
  trackRoutePath: (gameId: GameId, trackId: number | string, tab?: string) => string;
  tracksIndexPath: (gameId: GameId) => string;
  getGameRoute: (gameId: string) => string;
  countryName: (country: string) => string;
  tracksMatch: (candidate: string, name: string, variant?: string) => boolean;
  tuneMatchesTrack: (tune: TrackMatchTune, track: TrackMatchTarget) => boolean;
  parseUtcTimestamp: (value: string) => Date;
  formatLapTime: (value: number) => string;
  storedLapsSectorCount: (laps: readonly { sectorTimes?: number[] | null }[]) => number;
  getLocale: () => string;
  isDevelopment: boolean;
  SECTOR_COLOR_VARS: readonly string[];
  TRACK_CORNER_COLOR_VARS: readonly string[];
  TRACK_STRAIGHT_COLOR_VARS: readonly string[];
  VISUALIZATION_COLOR_VARS: readonly string[];
  getSemanticCanvasContext: (canvas: HTMLCanvasElement) => CanvasRenderingContext2D | null;
  drawTrack: (canvas: HTMLCanvasElement, points: Point[], large: boolean, sectors?: TrackSectors | null, zoom?: number, pan?: Point, sectorOverride?: { starts: number[] }, flipX?: boolean, sectorColors?: string[], perSegmentLabels?: boolean, highlightedSegments?: readonly number[] | null, highlightedSector?: number | null, pitLines?: readonly PitLine[] | null) => void;
  queryKeys: {
    trackSectors: (id: number | string) => readonly ["track-sectors", number | string];
    trackSectorBoundaries: (id: number | string) => readonly ["track-sector-boundaries", number | string];
    trackOutline: (id: number | string) => readonly ["track-outline", number | string];
  };
  operations: TracksCatalogueOperations;
}
