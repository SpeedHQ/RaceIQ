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

// Steering lock stored in localStorage so it persists across refreshes
const STEER_LOCK_KEY = "forza-steer-lock";

export function getSteeringLock(): number {
  const val = localStorage.getItem(STEER_LOCK_KEY);
  return val ? parseInt(val, 10) : 900;
}

export function Settings() {
  const [udpPort, setUdpPort] = useState("5300");
  const [savedPort, setSavedPort] = useState<number | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [steerLock, setSteerLock] = useState(() => String(getSteeringLock()));

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: { udpPort: number }) => {
        setUdpPort(String(data.udpPort));
        setSavedPort(data.udpPort);
      })
      .catch(() => {});
  }, []);

  const port = parseInt(udpPort, 10);
  const hasChanges = savedPort === null || port !== savedPort;

  async function handleSave() {
    const savePort = parseInt(udpPort, 10);
    if (isNaN(savePort) || savePort < 1024 || savePort > 65535) {
      setStatus("error");
      setErrorMsg("Port must be between 1024-65535");
      return;
    }

    setStatus("saving");
    setErrorMsg("");
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ udpPort: savePort }),
      });
      const text = await res.text();
      let data: { udpPort?: number; error?: string };
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Server error: ${text.slice(0, 100)}`);
      }
      if (!res.ok) {
        throw new Error(data.error || "Failed to save");
      }
      setSavedPort(data.udpPort);
      setUdpPort(String(data.udpPort));
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
          Set the UDP port to listen on. In Forza: Settings &gt; Gameplay &gt;
          Data Out &gt; set IP to this machine's address and the port below.
        </CardDescription>
      </CardHeader>
      <CardContent>
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
          <p className="text-red-400 text-sm mt-2">{errorMsg}</p>
        )}
        {savedPort && (
          <p className="text-slate-500 text-xs mt-3">
            Listening on 0.0.0.0:{savedPort}
          </p>
        )}

        <div className="mt-4 pt-4 border-t border-slate-800">
          <Label htmlFor="steer-lock" className="text-slate-400">
            Steering Wheel Rotation (degrees)
          </Label>
          <p className="text-xs text-slate-500 mb-1.5">
            Full lock-to-lock rotation of your wheel. Common: 900° (default), 540°, 360°, 270°
          </p>
          <div className="flex items-end gap-3">
            <Input
              id="steer-lock"
              type="number"
              min={180}
              max={1800}
              step={10}
              value={steerLock}
              onChange={(e) => {
                setSteerLock(e.target.value);
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val) && val >= 180 && val <= 1800) {
                  localStorage.setItem(STEER_LOCK_KEY, String(val));
                }
              }}
              className="bg-slate-800 border-slate-700 text-white font-mono w-24"
            />
            <span className="text-xs text-slate-500 mb-2">°</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
