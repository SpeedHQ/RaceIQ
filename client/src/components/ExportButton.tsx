import { useState } from "react";
import { client } from "../lib/rpc";
import { Button } from "./ui/button";

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
    <Button variant="app-primary" size="app-sm" onClick={handleExport} disabled={status === "copying"}>
      {status === "copied" ? "Copied!" : "Export"}
    </Button>
  );
}
