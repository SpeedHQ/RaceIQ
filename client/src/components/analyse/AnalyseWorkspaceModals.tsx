import { getGame } from "@shared/games/registry";
import { useNavigate } from "@tanstack/react-router";
import type { ComponentProps } from "react";
import type { SessionOwnership } from "../../../../shared/racing/sessions/types";
import { F1SetupModal } from "./F1SetupModal";
import { IbtImportPreviewModal } from "./IbtImportPreviewModal";
import { ImportResultModal } from "./ImportResultModal";
import { TuneViewModal } from "./TuneViewModal";
import type { AnalyseImportResult, IbtPreviewState } from "./useAnalyseImports";

type F1Setup = ComponentProps<typeof F1SetupModal>["setup"];

interface AnalyseWorkspaceModalsProps {
  viewingTuneId: number | null;
  onCloseTune: () => void;
  setup: F1Setup | null;
  onCloseSetup: () => void;
  ibtPreview: IbtPreviewState | null;
  importingBin: boolean;
  ownership: SessionOwnership;
  onOwnershipChange: (value: SessionOwnership) => void;
  onCommitIbt: () => void;
  onCancelIbt: () => void;
  importResult: AnalyseImportResult | null;
  gameId: string;
  setSelectedTrack: (value: number) => void;
  setSelectedCar: (value: number) => void;
  setSelectedLapId: (value: number) => void;
  onCloseImport: () => void;
}

export function AnalyseWorkspaceModals({
  viewingTuneId,
  onCloseTune,
  setup,
  onCloseSetup,
  ibtPreview,
  importingBin,
  ownership,
  onOwnershipChange,
  onCommitIbt,
  onCancelIbt,
  importResult,
  gameId,
  setSelectedTrack,
  setSelectedCar,
  setSelectedLapId,
  onCloseImport,
}: AnalyseWorkspaceModalsProps) {
  const navigate = useNavigate();

  return (
    <>
      {viewingTuneId && <TuneViewModal tuneId={viewingTuneId} onClose={onCloseTune} />}

      {setup && <F1SetupModal setup={setup} onClose={onCloseSetup} />}

      {ibtPreview && <IbtImportPreviewModal token={ibtPreview.token} preview={ibtPreview.preview} importing={importingBin} ownership={ownership} onOwnershipChange={onOwnershipChange} onImport={onCommitIbt} onClose={onCancelIbt} />}

      {importResult &&
        (() => {
          const sameGame = importResult.gameId === gameId;
          const lastLap = importResult.laps[importResult.laps.length - 1];
          return (
            <ImportResultModal
              fileName={importResult.fileName}
              packetCount={importResult.packetCount}
              laps={importResult.laps}
              sameGame={sameGame}
              gameLabel={getGame(importResult.gameId as Parameters<typeof getGame>[0])?.shortName ?? importResult.gameId}
              onGoToSession={
                lastLap
                  ? () => {
                      if (sameGame) {
                        setSelectedTrack(lastLap.trackOrdinal);
                        setSelectedCar(lastLap.carOrdinal);
                        setSelectedLapId(lastLap.lapId);
                      } else {
                        navigate({ to: `/${importResult.routePrefix}/analyse`, search: { track: lastLap.trackOrdinal, car: lastLap.carOrdinal, lap: lastLap.lapId } });
                      }
                      onCloseImport();
                    }
                  : undefined
              }
              onClose={onCloseImport}
            />
          );
        })()}
    </>
  );
}
