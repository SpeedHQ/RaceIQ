import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

interface SettingsData {
  forzaMachine: string;
  udpPort: number;
}

export function Settings() {
  const [machine, setMachine] = useState("0.0.0.0");
  const [udpPort, setUdpPort] = useState("5300");
  const [saved, setSaved] = useState<SettingsData | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: SettingsData) => {
        setMachine(data.forzaMachine);
        setUdpPort(String(data.udpPort));
        setSaved(data);
      })
      .catch(() => {});
  }, []);

  const hasChanges =
    saved !== null &&
    (machine !== saved.forzaMachine || parseInt(udpPort, 10) !== saved.udpPort);

  async function handleSave() {
    const port = parseInt(udpPort, 10);
    if (isNaN(port) || port < 1024 || port > 65535) {
      setStatus("error");
      setErrorMsg("Port must be between 1024-65535");
      return;
    }
    if (!machine.trim()) {
      setStatus("error");
      setErrorMsg("Forza machine address is required");
      return;
    }

    setStatus("saving");
    setErrorMsg("");
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ forzaMachine: machine.trim(), udpPort: port }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save");
      }
      const data: SettingsData = await res.json();
      setMachine(data.forzaMachine);
      setUdpPort(String(data.udpPort));
      setSaved(data);
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 2000);
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Failed to save");
    }
  }

  return (
    <Card className="bg-slate-900 border-slate-800">
      <CardHeader>
        <CardTitle className="text-white">Forza Connection</CardTitle>
        <CardDescription>
          Configure where to listen for Forza telemetry. Use 0.0.0.0 for local,
          or enter your Xbox/PC IP for a remote machine.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label htmlFor="forza-machine" className="text-slate-400">
            Forza Machine (IP or hostname)
          </Label>
          <Input
            id="forza-machine"
            type="text"
            value={machine}
            onChange={(e) => {
              setMachine(e.target.value);
              setStatus("idle");
            }}
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
            className="bg-slate-800 border-slate-700 text-white font-mono mt-1.5"
            placeholder="0.0.0.0 or 192.168.1.50"
          />
        </div>
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <Label htmlFor="udp-port" className="text-slate-400">
              UDP Port
            </Label>
            <Input
              id="udp-port"
              type="number"
              min={1024}
              max={65535}
              value={udpPort}
              onChange={(e) => {
                setUdpPort(e.target.value);
                setStatus("idle");
              }}
              onKeyDown={(e) => e.key === "Enter" && handleSave()}
              className="bg-slate-800 border-slate-700 text-white font-mono mt-1.5"
              placeholder="5300"
            />
          </div>
          <Button
            onClick={handleSave}
            disabled={status === "saving" || !hasChanges}
            variant={status === "saved" ? "secondary" : "default"}
            className="shrink-0"
          >
            {status === "saving"
              ? "Saving..."
              : status === "saved"
                ? "Saved"
                : "Apply"}
          </Button>
        </div>
        {status === "error" && (
          <p className="text-red-400 text-sm">{errorMsg}</p>
        )}
        {saved && (
          <p className="text-slate-500 text-xs">
            Listening on {saved.forzaMachine}:{saved.udpPort}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
