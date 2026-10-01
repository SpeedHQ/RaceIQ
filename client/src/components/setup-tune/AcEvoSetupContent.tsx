import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { summarizeAcEvoKnobs } from "@shared/racing/setups/ac-evo-content";
import { useInspectCarSetup } from "../../hooks/setup-queries";
import { m } from "../../paraglide/messages";
import { SetupSections } from "../tunes/SetupSections";

/** Same source sections as experiment View setup; old flat records show only retained values. */
export function AcEvoSetupContent({ settings, onChange }: {
  settings: Record<string, unknown>;
  onChange?: (knob: string, value: number | undefined) => void;
}) {
  const { mutateAsync: inspect } = useInspectCarSetup();
  const source = typeof settings.carSetupBase64 === "string" ? settings.carSetupBase64 : null;
  const content = useQuery({
    queryKey: ["carsetup-content", source],
    queryFn: () => inspect(source!),
    enabled: source != null,
    staleTime: Infinity,
  });
  const sections = useMemo(() => {
    if (content.data) return content.data.sections;
    const rows = summarizeAcEvoKnobs(settings);
    return onChange ? rows : rows.map((section) => ({ ...section, rows: section.rows.filter((row) => row.num != null) })).filter((section) => section.rows.length > 0);
  }, [content.data, settings, onChange]);

  if (content.isFetching) return <p className="text-app-text-muted">{m.common_loading()}</p>;
  if (content.error) return <p role="alert" className="text-status-danger">{m.experiment_setup_read_error()}</p>;
  return <SetupSections sections={sections} settings={settings} originalKnobs={content.data?.knobs} onChange={onChange} />;
}
