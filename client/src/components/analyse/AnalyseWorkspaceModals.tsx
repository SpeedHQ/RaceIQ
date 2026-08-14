import type { ComponentProps } from "react";
import { F1SetupModal } from "./F1SetupModal";
import { TuneViewModal } from "./TuneViewModal";

type F1Setup = ComponentProps<typeof F1SetupModal>["setup"];

interface AnalyseWorkspaceModalsProps {
  viewingTuneId: number | null;
  onCloseTune: () => void;
  setup: F1Setup | null;
  onCloseSetup: () => void;
}

export function AnalyseWorkspaceModals({
  viewingTuneId,
  onCloseTune,
  setup,
  onCloseSetup,
}: AnalyseWorkspaceModalsProps) {

  return (
    <>
      {viewingTuneId && <TuneViewModal tuneId={viewingTuneId} onClose={onCloseTune} />}

      {setup && <F1SetupModal setup={setup} onClose={onCloseSetup} />}

    </>
  );
}
