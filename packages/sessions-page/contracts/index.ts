import type { ComponentProps, ComponentType, ReactNode } from "react";
import type { Button as BaseButton } from "@base-ui/react/button";
import type { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { Toggle as BaseToggle } from "@base-ui/react/toggle";
import type { GameId } from "@raceiq/shared/games/ids";
import type { LapMeta, SessionMeta, SessionOwnership } from "@raceiq/shared/racing/sessions/types";
import type { OpponentLapCatalog } from "@raceiq/lap-replay/contracts";
import type { SessionCleanupRequest, SessionCleanupResult } from "@raceiq/shared/racing/sessions/cleanup";
import type { SessionsMessages } from "./messages";
export type { SessionsMessages } from "./messages";

export { validateSessionsSearch } from "./search";
export type { SessionsTab, SessionsSearch } from "./search";
export type SessionExportSelection = { lapIds?: number[]; sessionIds?: number[] };
export type SessionNames = { trackNames: Record<string, string>; carNames: Record<string, string> };
export type LiveCaptureLifecycle = { phase: "recording" | "finalizing" | "sealed" | "failed"; error?: string };
export interface IbtImportPreview {
  gameId: "iracing";
  fileName: string;
  fileSize: number;
  tickRate: number;
  recordCount: number;
  durationSeconds: number;
  sessionStartDate: string;
  trackId: string;
  trackName: string;
  carId: string;
  carName: string;
  carClassName: string;
  missingRaceIQVariables: string[];
  missingRequiredVariables: string[];
  drivingFrames: number;
  pitRoadFrames: number;
  lapTransitions: number;
  candidateLapCount: number;
  maxSpeedMph: number;
  firstDrivingRecord: number | null;
  lastDrivingRecord: number | null;
  canImport: boolean;
  reason: string | null;
}
export interface IbtImportPreviewModalProps {
  token: string | null;
  preview: IbtImportPreview;
  importing: boolean;
  ownership: SessionOwnership;
  onOwnershipChange: (value: SessionOwnership) => void;
  onImport: () => void;
  onClose: () => void;
}
export interface IbtImportActions {
  importingBin: boolean;
  ownership: SessionOwnership;
  setOwnership: (value: SessionOwnership) => void;
  ibtPreview: { token: string | null; preview: IbtImportPreview } | null;
  handleImportBin: (file: File) => Promise<void>;
  handleCancelIbt: () => void;
  handleCommitIbt: () => Promise<{ laps: { lapId: number }[]; packetCount: number; gameId: string } | undefined>;
}
export interface IbtImportHost {
  IbtImportPreviewModal: ComponentType<IbtImportPreviewModalProps>;
  useIbtImport: () => IbtImportActions;
}
export interface SessionsPageHost extends IbtImportHost {
  m: SessionsMessages;
  Button: ComponentType<BaseButton.Props & { variant?: "app-outline" | "app-primary" | "app-ghost" | "app-danger"; size?: "app-sm" | "app-md" | "icon-xs" }>;
  Badge: ComponentType<ComponentProps<"span"> & { variant?: "neutral" | "info"; size?: "compact" }>;
  Table: ComponentType<ComponentProps<"table">>;
  TableBody: ComponentType<ComponentProps<"tbody">>;
  TableCell: ComponentType<ComponentProps<"td">>;
  TableHead: ComponentType<ComponentProps<"th">>;
  TableHeader: ComponentType<ComponentProps<"thead">>;
  TableRow: ComponentType<ComponentProps<"tr">>;
  SortableTableHead: ComponentType<Omit<ComponentProps<"th">, "onClick" | "aria-sort"> & { direction?: "ascending" | "descending"; onSort: () => void }>;
  AppInput: ComponentType<ComponentProps<"input">>;
  Toggle: ComponentType<BaseToggle.Props & { variant?: "app-outline"; size?: "app-md"; showStar?: boolean }>;
  ToggleGroup03: ComponentType<{ ariaLabel: string; options: readonly { value: string; label: ReactNode }[]; value: string; onValueChange: (value: string) => void }>;
  Dialog: ComponentType<BaseDialog.Root.Props>;
  DialogContent: ComponentType<BaseDialog.Popup.Props & { size?: "lg"; layout?: "scrollable"; showCloseButton?: boolean; overlayClassName?: string }>;
  DialogHeader: ComponentType<ComponentProps<"div">>;
  DialogTitle: ComponentType<BaseDialog.Title.Props & { variant?: "import" }>;
  NoteModal: ComponentType<{ value?: string; onSave: (value: string) => void; onClose: () => void }>;
  FavoriteToggleButton: ComponentType<{ target: "lap" | "session"; id: number; isFavorite: boolean }>;
  SessionTypeBadge: ComponentType<{ type?: string | null; label?: string }>;
  SessionCleanupDialog: ComponentType<{ request: SessionCleanupRequest | null; onClose: () => void; onCompleted: (result: SessionCleanupResult) => void }>;
  RaceResultLedger: ComponentType<{ sessionId: number; gameId: GameId; enabled: boolean; laps: readonly LapMeta[] }>;
  SessionIdentityDialog: ComponentType<{ gameId: GameId; initialCarId?: string | null; initialTrackId?: string | null; onSave: (identity: { carId: string; trackId: string }) => Promise<void>; onClose: () => void }>;
  MotecImportModal: ComponentType<{ initialGameId?: GameId | null; initialLd?: File | null; ownership?: SessionOwnership; onOwnershipChange?: (ownership: SessionOwnership) => void; onClose: () => void; onImported: (result: { imported: number; gameId: string }) => void }>;
  OwnershipChoice: ComponentType<{ value: SessionOwnership; onChange: (value: SessionOwnership) => void; disabled?: boolean }>;
  ImportSetupFile: ComponentType<{ gameId: "acc" | "ac-evo"; routePrefix: string; gameLabel: string; cars: { id: string; name: string }[]; initialFile?: File; onClose?: () => void }>;
  useAcEvoCars: () => { data?: { id: string; name: string }[] };
  useLiveCaptureLifecycle: (sessionId: number | undefined) => LiveCaptureLifecycle | null;
  useOpponentLapCatalog: (playerLapId: number | null) => { data?: OpponentLapCatalog; isLoading: boolean; isFetching: boolean; error?: Error | null; refetch: () => Promise<unknown> };
  useGameId: () => GameId | null;
  useGameRoute: () => string;
  useSessions: () => { data?: SessionMeta[]; isLoading: boolean; isError: boolean };
  useLaps: () => { data?: LapMeta[] };
  useDeleteLap: () => unknown;
  useResolveNames: (trackIds: string[], carIds: string[]) => { data?: SessionNames };
  authenticatedFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  importLapsZip: (file: File, ownership?: SessionOwnership, identityOverrides?: Record<string, { carId: string; trackId: string }>) => Promise<{ imported: number; skipped: number }>;
  exportLapsZip: (selection: SessionExportSelection) => Promise<void>;
  deleteSessions: (ids: number[]) => Promise<Pick<Response, "ok">>;
  deleteLaps: (ids: number[]) => Promise<Pick<Response, "ok">>;
  patchSessionNotes: (id: number, notes: string | null) => Promise<unknown>;
  patchLapNotes: (id: number, notes: string | null) => Promise<unknown>;
  queryKeys: Record<"sessions" | "laps" | "userTunes" | "storageSessions" | "cacheStatus", readonly unknown[]>;
  invalidateDashboardQueries: () => void;
  storedLapsSectorCount: (laps: readonly LapMeta[]) => number;
  bestSectorLapIds: (laps: readonly LapMeta[], sectorCount: number) => (number | null)[];
  formatLapTime: (seconds: number) => string;
  getLocale: () => string;
  routePrefixForGameId: (gameId: GameId) => string | undefined;
}
