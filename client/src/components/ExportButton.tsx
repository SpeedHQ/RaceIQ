import { useState } from "react";
import { client } from "../lib/rpc";

interface Props {
  lapId: number;
}

export function ExportButton({ lapId }: Props) {
  const [status, setStatus] = useState<"idle" | "copying" | "copied">("idle");

  async function handleExport() {
    setStatus("copying");
    try {
      const blob = await client.api.laps[":id"].export.$get({ param: { id: String(lapId) } }).then((r) => r.blob());
      const text = await blob.text();
      await navigator.clipboard.writeText(text);
      setStatus("copied");
      setTimeout(() => setStatus("idle"), 2000);
    } catch {
      setStatus("idle");
    }
  }

  return (
    <button onClick={handleExport} disabled={status === "copying"} className="px-2 py-1 text-xs rounded bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-50 transition-colors">
      {status === "copied" ? "Copied!" : "Export"}
    </button>
  );
}
