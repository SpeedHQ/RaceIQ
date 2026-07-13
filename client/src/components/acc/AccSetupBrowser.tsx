import { SetupBrowser } from "@/components/tune/browser/SetupBrowser";
import type { ComboOption } from "@/components/tune/browser/ComboBox";
import type { SourceTab, TuneRow } from "@/components/tune/browser/types";
import { client } from "@/lib/rpc";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

interface AccSetup {
  name: string;
  carModel: string;
  carClass?: string;
  trackName: string;
  downloadUrl?: string;
  driveUrl?: string;
  pageUrl?: string;
  videoUrl?: string;
  notes?: string;
  author?: string;
  lapTime?: string;
  hasWet?: boolean;
  setupFile?: string;
}

interface AccCar {
  model: string;
  name: string;
}

const SOURCES: SourceTab[] = [{ key: "all", label: "All" }];

// "1:23.456" | "83.456" -> seconds
function parseLap(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = raw.match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return (m[1] ? Number(m[1]) : 0) * 60 + Number(m[2]);
}

interface AccSetupFile {
  basicSetup?: {
    tyres?: { tyreCompound?: number; tyrePressure?: number[] };
    alignment?: { camber?: number[]; toe?: number[]; casterLF?: number; casterRF?: number; steerRatio?: number };
    electronics?: { tC1?: number; tC2?: number; abs?: number; eCUMap?: number; fuelMix?: number };
    strategy?: { fuel?: number };
  };
  advancedSetup?: {
    mechanicalBalance?: { aRBFront?: number; aRBRear?: number; wheelRate?: number[]; brakeTorque?: number; brakeBias?: number };
    dampers?: { bumpSlow?: number[]; bumpFast?: number[]; reboundSlow?: number[]; reboundFast?: number[] };
    aeroBalance?: { rideHeight?: number[]; rearWing?: number; splitter?: number; brakeDuct?: number[] };
    drivetrain?: { preload?: number };
  };
}

function fmt(v: number | number[] | undefined): string {
  if (v == null) return "—";
  return Array.isArray(v) ? v.join("  ") : String(v);
}

function AccSetupValues({ data }: { data: AccSetupFile }) {
  const b = data.basicSetup ?? {};
  const a = data.advancedSetup ?? {};
  const groups: { title: string; rows: [string, number | number[] | undefined][] }[] = [
    {
      title: "Tyres",
      rows: [
        ["Compound", b.tyres?.tyreCompound],
        ["Pressure", b.tyres?.tyrePressure],
      ],
    },
    {
      title: "Alignment",
      rows: [
        ["Camber", b.alignment?.camber],
        ["Toe", b.alignment?.toe],
        ["Caster L/R", [b.alignment?.casterLF ?? 0, b.alignment?.casterRF ?? 0]],
        ["Steer ratio", b.alignment?.steerRatio],
      ],
    },
    {
      title: "Electronics",
      rows: [
        ["TC1 / TC2", [b.electronics?.tC1 ?? 0, b.electronics?.tC2 ?? 0]],
        ["ABS", b.electronics?.abs],
        ["ECU map", b.electronics?.eCUMap],
        ["Fuel mix", b.electronics?.fuelMix],
      ],
    },
    {
      title: "Mechanical",
      rows: [
        ["ARB F/R", [a.mechanicalBalance?.aRBFront ?? 0, a.mechanicalBalance?.aRBRear ?? 0]],
        ["Wheel rate", a.mechanicalBalance?.wheelRate],
        ["Brake bias", a.mechanicalBalance?.brakeBias],
        ["Brake torque", a.mechanicalBalance?.brakeTorque],
        ["Preload", a.drivetrain?.preload],
      ],
    },
    {
      title: "Dampers",
      rows: [
        ["Bump slow", a.dampers?.bumpSlow],
        ["Bump fast", a.dampers?.bumpFast],
        ["Reb. slow", a.dampers?.reboundSlow],
        ["Reb. fast", a.dampers?.reboundFast],
      ],
    },
    {
      title: "Aero",
      rows: [
        ["Ride height", a.aeroBalance?.rideHeight],
        ["Rear wing", a.aeroBalance?.rearWing],
        ["Splitter", a.aeroBalance?.splitter],
        ["Brake duct F/R", a.aeroBalance?.brakeDuct],
      ],
    },
  ];
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-x-6 content-start">
      {groups.map((g) => (
        <div key={g.title}>
          <div className="text-xs text-app-accent uppercase tracking-wider font-bold mt-2 mb-1 border-b border-app-border/20 pb-0.5">{g.title}</div>
          {g.rows.map(([label, val]) => (
            <div key={label} className="flex justify-between gap-3 py-0.5">
              <span className="text-app-label font-semibold text-app-text">{label}</span>
              <span className="text-app-label font-mono font-medium text-app-text tabular-nums">{fmt(val)}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function AccSetupPanel({ setup }: { setup: AccSetup }) {
  const install = useMutation({
    mutationFn: () =>
      client.api.acc.setups.install
        .$post({ json: { carModel: setup.carModel, trackName: setup.trackName, setupFile: setup.setupFile! } })
        .then((r) => r.json() as Promise<unknown>),
  });
  // Fetch the raw ACC setup JSON lazily — this panel only mounts when the row
  // is expanded, so the request fires on expand.
  const { data: file, isLoading } = useQuery<AccSetupFile | null>({
    queryKey: ["acc-setup-file", setup.setupFile],
    enabled: !!setup.setupFile,
    queryFn: async () => {
      const res = await client.api.acc["setup-file"].$get({ query: { file: setup.setupFile! } });
      if (!res.ok) return null;
      return (await res.json()) as unknown as AccSetupFile;
    },
  });
  const isVideo = (u?: string) => !!u && /youtube\.com|youtu\.be|vimeo\.com/.test(u);
  // Many ACC setups are YouTube guides whose real file link (Google Drive, etc.)
  // lives in the video description — resolve it via yt-meta, same as track detail.
  const ytVideoId = useMemo(() => {
    const url = setup.downloadUrl || setup.videoUrl || "";
    return url.match(/(?:v=|youtu\.be\/|embed\/)([\w-]{11})/)?.[1] ?? null;
  }, [setup.downloadUrl, setup.videoUrl]);
  const { data: ytMeta, isLoading: ytLoading } = useQuery<{ uploadDate?: string; downloadUrl?: string } | null>({
    queryKey: ["acc-yt-meta", ytVideoId],
    enabled: !!ytVideoId,
    staleTime: Infinity,
    queryFn: async () => {
      const res = await client.api.acc["yt-meta"].$get({ query: { videoId: ytVideoId! } });
      if (!res.ok) return null;
      return (await res.json()) as { uploadDate?: string; downloadUrl?: string };
    },
  });
  // downloadUrl often duplicates the video link for guide-only setups — only
  // treat a non-video URL, a Drive link, or the yt-meta-resolved link as a file.
  const videoUrl = setup.videoUrl || (isVideo(setup.downloadUrl) ? setup.downloadUrl : undefined);
  const fileUrl = setup.driveUrl || ytMeta?.downloadUrl || (setup.downloadUrl && !isVideo(setup.downloadUrl) ? setup.downloadUrl : undefined);

  return (
    <div className="space-y-2.5">
      {setup.notes && <p className="text-xs text-app-text-muted leading-relaxed whitespace-pre-line max-w-[70ch]">{setup.notes}</p>}
      {setup.setupFile && (
        <div>
          {isLoading && <div className="text-app-text-dim text-xs">Loading setup…</div>}
          {file && <AccSetupValues data={file} />}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {setup.setupFile && (
          <button
            type="button"
            className="text-[11px] uppercase tracking-wide px-4 py-2 rounded bg-app-accent text-app-bg font-bold disabled:opacity-50"
            onClick={() => install.mutate()}
            disabled={install.isPending || install.isSuccess}
          >
            {install.isSuccess ? "Installed ✓" : install.isPending ? "Installing…" : "Install to ACC"}
          </button>
        )}
        {fileUrl ? (
          <a
            href={fileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] uppercase tracking-wide px-4 py-2 rounded border border-app-border text-app-text-secondary hover:text-app-text no-underline"
          >
            Download
          </a>
        ) : (
          ytVideoId &&
          ytLoading && (
            <span className="text-[11px] uppercase tracking-wide px-4 py-2 rounded border border-app-border text-app-text-muted inline-flex items-center gap-1.5 cursor-wait" aria-busy="true">
              <span className="w-3 h-3 rounded-full border-2 border-app-border border-t-app-accent animate-spin" />
              Download
            </span>
          )
        )}
        {videoUrl && (
          <a
            href={videoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] uppercase tracking-wide px-4 py-2 rounded border border-app-border text-red-400 hover:text-red-300 no-underline"
          >
            ▶ Video
          </a>
        )}
        {setup.pageUrl && (
          <a
            href={setup.pageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] uppercase tracking-wide px-4 py-2 rounded border border-app-border text-app-text-muted hover:text-app-text no-underline"
          >
            Source
          </a>
        )}
      </div>
    </div>
  );
}

export function AccSetupBrowser() {
  const { data: setups = [] } = useQuery<AccSetup[]>({
    queryKey: ["acc-setups", "all"],
    queryFn: () => client.api.acc.setups.$get({ query: {} }).then((r) => r.json() as unknown as AccSetup[]),
  });
  const { data: cars = [] } = useQuery<AccCar[]>({
    queryKey: ["acc-cars"],
    queryFn: () => client.api.acc.cars.$get().then((r) => r.json() as unknown as AccCar[]),
  });

  const { rows, carNames, trackNames } = useMemo(() => {
    const carModelName = new Map(cars.map((c) => [c.model, c.name] as const));
    const carOrdinals = new Map<string, number>();
    const trackOrdinals = new Map<string, number>();
    const carNames: Record<number, string> = {};
    const trackNames: Record<number, string> = {};
    const rows: TuneRow[] = [];

    setups.forEach((s, i) => {
      const car = s.carModel || "Unknown";
      let cOrd = carOrdinals.get(car);
      if (cOrd == null) {
        cOrd = carOrdinals.size;
        carOrdinals.set(car, cOrd);
        carNames[cOrd] = carModelName.get(car) ?? car;
      }
      const track = s.trackName || "Unknown";
      let tOrd = trackOrdinals.get(track);
      if (tOrd == null) {
        tOrd = trackOrdinals.size;
        trackOrdinals.set(track, tOrd);
        trackNames[tOrd] = track;
      }
      rows.push({
        key: `${s.carModel}-${s.trackName}-${i}`,
        id: `${s.carModel}-${s.trackName}-${i}`,
        dbId: null,
        name: s.name || s.author || "Setup",
        author: s.author || "Unknown",
        source: "community",
        category: s.hasWet ? "wet" : "dry",
        carOrdinal: cOrd,
        trackOrdinal: tOrd,
        lapTimeSec: parseLap(s.lapTime),
        lapTimeRaw: s.lapTime || null,
        lapTimeTrack: track,
        description: s.carClass ?? "",
        settings: s,
      });
    });
    return { rows, carNames, trackNames };
  }, [setups, cars]);

  const carOptions: ComboOption[] = useMemo(() => {
    const counts = new Map<number, number>();
    for (const r of rows) counts.set(r.carOrdinal, (counts.get(r.carOrdinal) ?? 0) + 1);
    const opts = [...counts.entries()].map(([ord, count]) => ({ value: String(ord), label: carNames[ord] ?? `Car ${ord}`, count })).sort((a, b) => b.count - a.count);
    return [{ value: "any", label: "Any car", count: rows.length }, ...opts];
  }, [rows, carNames]);

  const trackOptions: ComboOption[] = useMemo(() => {
    const counts = new Map<number, number>();
    for (const r of rows) if (r.trackOrdinal != null) counts.set(r.trackOrdinal, (counts.get(r.trackOrdinal) ?? 0) + 1);
    const opts = [...counts.entries()].map(([ord, count]) => ({ value: String(ord), label: trackNames[ord] ?? `Track ${ord}`, count })).sort((a, b) => b.count - a.count);
    return [{ value: "any", label: "Any track", count: rows.length }, ...opts];
  }, [rows, trackNames]);

  return (
    <SetupBrowser
      rows={rows}
      carNames={carNames}
      trackNames={trackNames}
      trackOptions={trackOptions}
      carOptions={carOptions}
      sources={SOURCES}
      renderSettings={(row: TuneRow) => <AccSetupPanel setup={row.settings as AccSetup} />}
      readOnly
    />
  );
}
