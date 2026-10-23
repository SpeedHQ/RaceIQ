import { Settings2 } from "lucide-react";
import { m } from "@/paraglide/messages";
import { Button } from "../ui/button";
import { DropdownMenu } from "../ui/DropdownMenu";

interface AiPanelMenuProps {
  onClearChat: () => void;
  onClearAnalysis: () => void;
  onClearAll: () => void;
}

export function AiPanelMenu({ onClearChat, onClearAnalysis, onClearAll }: AiPanelMenuProps) {
  return (
    <DropdownMenu
      trigger={
        <Button variant="app-ghost" size="app-sm" className="max-sm:size-11" aria-label={m.aipanel_manage()} title={m.aipanel_manage()}>
          <Settings2 />
        </Button>
      }
      items={[
        { key: "chat", label: m.aipanel_clear_chat_only(), onClick: onClearChat },
        { key: "analysis", label: m.aipanel_clear_analysis_keep_chat(), onClick: onClearAnalysis },
        { key: "all", label: m.aipanel_clear_all(), onClick: onClearAll, className: "text-status-danger" },
      ]}
    />
  );
}
