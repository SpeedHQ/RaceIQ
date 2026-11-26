import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { IbtImportPreviewModal } from "@/components/analyse/IbtImportPreviewModal";
import { useAnalyseImports } from "@/components/analyse/useAnalyseImports";
import { SessionsPageProvider } from "@raceiq/sessions-page/ui";
import type { SessionsPageHost } from "@raceiq/sessions-page/contracts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { AppInput } from "@/components/ui/AppInput";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup03 } from "@/components/shadcn-studio/toggle-group/toggle-group-03";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NoteModal } from "@/components/ui/NoteModal";
import { FavoriteToggleButton } from "@/components/FavoriteToggleButton";
import { SessionTypeBadge } from "@/components/SessionTypeBadge";
import { SessionCleanupDialog } from "@/components/SessionCleanupDialog";
import { RaceResultLedger } from "@/components/race-results/RaceResultLedger";
import { SessionIdentityDialog } from "@/components/import/SessionIdentityDialog";
import { MotecImportModal } from "@/components/analyse/MotecImportModal";
import { OwnershipChoice } from "@/components/import/OwnershipChoice";
import { ImportSetupFile } from "@/components/setup-tune/ImportSetupFile";
import { useAcEvoCars } from "@/components/setup-tune/use-game-cars";
import { useDeleteLap, useLaps } from "@/hooks/laps";
import { useSessions } from "@/hooks/session-queries";
import { useResolveNames } from "@/hooks/catalog-queries";
import { queryKeys } from "@/hooks/query-keys";
import { invalidateDashboardQueries } from "@/hooks/dashboard";
import { authenticatedFetch, client } from "@/lib/rpc";
import { importLapsZip, exportLapsZip } from "@/lib/lap-export";
import { storedLapsSectorCount, bestSectorLapIds } from "@/lib/lap-sectors";
import { formatLapTime } from "@/lib/format";
import { routePrefixForGameId } from "@/lib/game-routes";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";
import { useGameId, useGameRoute } from "@/stores/game";
import { useOpponentLapCatalog } from "@/hooks/opponents";
import { useTelemetryStore } from "@/stores/telemetry";

function useIbtImport() {
  const queryClient = useQueryClient();
  return useAnalyseImports({ queryClient });
}
export const sessionsPageHost: SessionsPageHost = {
  m, Button, Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
  SortableTableHead, AppInput, Toggle, ToggleGroup03, Dialog, DialogContent, DialogHeader, DialogTitle,
  NoteModal, FavoriteToggleButton, SessionTypeBadge, SessionCleanupDialog, RaceResultLedger,
  SessionIdentityDialog, MotecImportModal, OwnershipChoice, ImportSetupFile, useAcEvoCars, IbtImportPreviewModal, useIbtImport,
  useGameId, useGameRoute, useSessions, useLaps, useDeleteLap, useResolveNames,
  useOpponentLapCatalog,
  useLiveCaptureLifecycle: (sessionId) => useTelemetryStore((state) => state.liveCaptureLifecycles[sessionId ?? -1] ?? null),
  authenticatedFetch, importLapsZip, exportLapsZip, queryKeys, invalidateDashboardQueries,
  storedLapsSectorCount, bestSectorLapIds, formatLapTime, getLocale, routePrefixForGameId,
  deleteSessions: (ids) => client.api.sessions["bulk-delete"].$post({ json: { ids } }),
  deleteLaps: (ids) => client.api.laps["bulk-delete"].$post({ json: { ids } }),
  patchSessionNotes: (id, notes) => client.api.sessions[":id"].notes.$patch({ param: { id: String(id) }, json: { notes } }),
  patchLapNotes: (id, notes) => client.api.laps[":id"].notes.$patch({ param: { id: String(id) }, json: { notes } }),
};

export function SessionsPageHostProvider({ children }: { children: ReactNode }) {
  return <SessionsPageProvider host={sessionsPageHost}>{children}</SessionsPageProvider>;
}
