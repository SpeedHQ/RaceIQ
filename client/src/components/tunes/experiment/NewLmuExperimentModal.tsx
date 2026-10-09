import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { DEFAULT_EXPERIMENT_FOCUS, type ExperimentFocus } from "@raceiq/shared/racing/experiments/focus";
import { FocusPicker } from "@/components/tunes/FocusPicker";
import { AppInput } from "@/components/ui/AppInput";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { useLmuSetupFiles } from "@/hooks/lmu-setup-queries";
import { lmuTrackCatalog } from "@raceiq/game-lmu-metadata/catalog";
import { useCreateExperiment } from "@/hooks/experiments";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";

export function NewLmuExperimentModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const listing = useLmuSetupFiles();
  const create = useCreateExperiment();
  const { data: catalogCars = [] } = useQuery({
    queryKey: ["cars", "lmu"],
    queryFn: async () => {
      const response = await client.api.cars.$get({}, { headers: { "X-Game-Id": "lmu" } });
      if (!response.ok) throw new Error("Could not load LMU cars");
      return response.json() as Promise<{ id: string | null; name: string; ordinal: number | null }[]>;
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [track, setTrack] = useState("");
  const [car, setCar] = useState("");
  const [setupPath, setSetupPath] = useState("");
  const [name, setName] = useState("");
  const [focus, setFocus] = useState<ExperimentFocus>(DEFAULT_EXPERIMENT_FOCUS);
  const [error, setError] = useState<string | null>(null);
  const files = listing.data?.files ?? [];
  const tracks = useMemo(() => {
    const values = new Map<string, string>();
    for (const item of lmuTrackCatalog) values.set(item.id, item.name);
    for (const item of listing.data?.tracks ?? []) values.set(item.trackId ?? item.folder, item.trackName);
    return [...values].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [listing.data]);
  const selectedTrack = tracks.find((item) => item.value === track);
  const selectedTrackInfo = listing.data?.tracks?.find((item) => (item.trackId ?? item.folder) === track);
  const filesForTrack = (file: (typeof files)[number]) => !track || file.trackId === track || (!file.trackId && file.trackFolder === track);
  const cars = [...new Map([...catalogCars.map((item) => [item.id ?? item.name, item.name] as const), ...files.filter((file) => !file.error && filesForTrack(file)).map((file) => [file.carId ?? file.carName ?? "", file.carName ?? file.carId ?? ""] as const)]).entries()]
    .filter(([value]) => value).map(([value, label]) => ({ value, label }));
  const selectedCar = cars.find((item) => item.value === car);
  const matchingFiles = files.filter((file) => !file.error && filesForTrack(file) && (!car || file.carId === car || file.carName === selectedCar?.label || (!file.carId && file.carName === car)));
  const selectedFile = matchingFiles.find((file) => file.path === setupPath);
  const effectiveName = name.trim() || (selectedCar && selectedTrack ? `${selectedCar.label} @ ${selectedTrack.label}` : "");
  const canCreate = !!track && !!car && !!effectiveName && (focus === "driver" || !!selectedFile);
  const submit = async () => {
    if (!canCreate || !selectedTrack) return;
    try {
      const created = await create.mutateAsync({ gameId: "lmu", name: effectiveName, carName: selectedCar?.label ?? null, trackName: selectedTrackInfo?.trackName ?? selectedTrack.label, baseSetupPath: selectedFile?.path ?? null, focus });
      onCreated(created.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : m.experiment_create_error()); }
  };
  return <Dialog open onOpenChange={(open) => !open && onClose()}><DialogContent size="md" layout="scrollable"><DialogHeader><DialogTitle>{m.experiment_new_title()}</DialogTitle></DialogHeader>
    <FocusPicker value={focus} onChange={setFocus} />
    {listing.isError && <div role="alert" className="text-sm text-status-danger">Could not load LMU setups.</div>}
    <label className="flex flex-col gap-1"><span className="text-app-compact text-app-text-muted">{m.label_track()}</span><SearchSelect value={track} onChange={(value) => { setTrack(value); setCar(""); setSetupPath(""); }} options={tracks} placeholder={m.experiment_search_tracks()} /></label>
    <label className="flex flex-col gap-1"><span className="text-app-compact text-app-text-muted">{m.label_car()}</span><SearchSelect value={car} onChange={(value) => { setCar(value); setSetupPath(""); }} options={cars} placeholder={m.experiment_search_cars()} /></label>
    {focus !== "driver" && <label className="flex flex-col gap-1"><span className="text-app-compact text-app-text-muted">{m.experiment_base_setup()}</span><SearchSelect value={setupPath} onChange={setSetupPath} options={matchingFiles.map((file) => ({ value: file.path, label: file.fileName }))} placeholder={m.experiment_search_setups()} /></label>}
    <label className="flex flex-col gap-1"><span className="text-app-compact text-app-text-muted">{m.experiment_session_name()}</span><AppInput value={name} onChange={(event) => setName(event.target.value)} placeholder={effectiveName || m.experiment_session_name()} maxLength={120} /></label>
    {error && <div role="alert" className="text-sm text-status-danger">{error}</div>}
    <DialogFooter><Button variant="app-outline" size="app-md" onClick={onClose}>{m.common_cancel()}</Button><Button variant="app-primary" size="app-md" onClick={() => void submit()} disabled={create.isPending || !canCreate}>{create.isPending ? m.experiment_creating() : m.experiment_create_session()}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
