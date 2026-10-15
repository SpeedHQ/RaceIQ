import { RecordingDirectoryControl } from "@/components/settings/RecordingDirectoryControl";
import { RecordingLayoutMigration } from "@/components/RecordingLayoutMigration";
import { m } from "@/paraglide/messages";

export function StorageStep() {
  return <div className="space-y-4"><h2 className="text-lg font-semibold text-app-text">{m.label_storage()}</h2><RecordingDirectoryControl inline /><RecordingLayoutMigration compact /></div>;
}
