import { useEffect, useState } from "react";
import { getParameterAdvice, getPresetAdvice, getSymptomAdvice } from "@raceiq/game-lmu-metadata/setups/knowledge";
import type { SvmDocument } from "@raceiq/game-lmu-metadata/setups/svm";
import { m } from "@/paraglide/messages";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export interface LmuSetupAdviceProps { document: SvmDocument | null; parameterId?: string | null; onParameterChange?: (id: string) => void }

const REASON_LABELS: Record<string, () => string> = {
  "Select a setup for car-specific applicability.": m.lmu_setup_select_setup_applicability, "This car is not hybrid.": m.lmu_setup_reason_not_hybrid,
  "Hybrid capability is unknown for this car.": m.lmu_setup_reason_hybrid_unknown, "This car does not have front drive.": m.lmu_setup_reason_no_frontdrive,
  "Front-drive capability is unknown for this car.": m.lmu_setup_reason_frontdrive_unknown, "This advice is only for cars without ABS.": m.lmu_setup_reason_abs_required, "ABS capability is unknown for this car.": m.lmu_setup_reason_abs_unknown,
  "Field is not a mapped setting": m.lmu_setup_reason_unmapped, "Fuel carried is derived": m.lmu_setup_reason_derived, "Field has no display label": m.lmu_setup_reason_no_label, "Field is fixed or unavailable": m.lmu_setup_reason_fixed,
  "Front-drive capability is unknown": m.lmu_setup_reason_frontdrive_unknown, "Field requires front-wheel drive": m.lmu_setup_reason_frontdrive_required, "Hybrid capability is unknown": m.lmu_setup_reason_hybrid_unknown, "Field requires hybrid capability": m.lmu_setup_reason_hybrid_required,
};
function localizedReason(reason: string | null): string {
  return reason ? REASON_LABELS[reason]?.() ?? reason : "";
}

export function LmuSetupAdvice({ document, parameterId, onParameterChange }: LmuSetupAdviceProps) {
  const [view, setView] = useState("parameters");
  const parameters = getParameterAdvice(document);
  const symptoms = getSymptomAdvice(document);
  const presets = getPresetAdvice(document);
  const focus = (id: string) => { onParameterChange?.(id); setView("parameters"); };
  useEffect(() => {
    if (parameterId && view === "parameters") window.document.getElementById(`lmu-parameter-${parameterId}`)?.scrollIntoView({ block: "start" });
  }, [parameterId, view]);
  return <div className="flex flex-col gap-4">
    {!document && <p role="note" className="rounded border border-status-info/40 bg-status-info/10 p-3 text-app-subtext">{m.lmu_setup_advice_general()}</p>}
    <Tabs value={view} onValueChange={setView}>
      <TabsList><TabsTrigger value="parameters">{m.lmu_setup_advice_parameters()}</TabsTrigger><TabsTrigger value="diagnose">{m.lmu_setup_advice_diagnose()}</TabsTrigger><TabsTrigger value="requests">{m.lmu_setup_advice_requests()}</TabsTrigger></TabsList>
      <TabsContent value="parameters" className="mt-3 flex flex-col gap-3">{parameters.map(({ item, availability }) => <Card key={item.id} size="sm" id={`lmu-parameter-${item.id}`}>
        <CardHeader><CardTitle>{item.name} <span className="text-app-caption text-app-text-muted">· {item.group}</span></CardTitle><p>{item.does}</p><p className="text-app-subtext text-app-text-muted">{item.note}</p>{!availability.available && <Badge variant="warning">{localizedReason(availability.reason)}</Badge>}{parameterId === item.id && <Badge variant="info">{m.lmu_setup_advice_selected()}</Badge>}</CardHeader>
        <CardContent className="flex flex-col gap-3"><div><strong>{item.upLabel}</strong><ul className="list-disc pl-5">{item.up.effects.map((effect, index) => <li key={index}>{effect}</li>)}</ul>{item.up.compensations.map((entry) => <p key={entry.id} className="text-app-subtext">{m.lmu_setup_compensation()}: {entry.text} <Button variant="link" size="sm" onClick={() => focus(entry.id)}>{parameters.find((candidate) => candidate.item.id === entry.id)?.item.name ?? entry.id}</Button></p>)}</div>
          <div><strong>{item.downLabel}</strong><ul className="list-disc pl-5">{item.down.effects.map((effect, index) => <li key={index}>{effect}</li>)}</ul>{item.down.compensations.map((entry) => <p key={entry.id} className="text-app-subtext">{m.lmu_setup_compensation()}: {entry.text} <Button variant="link" size="sm" onClick={() => focus(entry.id)}>{parameters.find((candidate) => candidate.item.id === entry.id)?.item.name ?? entry.id}</Button></p>)}</div>
          {item.linked.length > 0 && <div>{m.lmu_setup_linked_effects()}: <ul>{item.linked.map((linked) => <li key={linked.id}><Button variant="link" size="sm" onClick={() => focus(linked.id)}>{parameters.find((candidate) => candidate.item.id === linked.id)?.item.name ?? linked.id}</Button> {linked.reason}</li>)}</ul></div>}
        </CardContent></Card>)}</TabsContent>
      <TabsContent value="diagnose" className="mt-3 flex flex-col gap-3">{symptoms.map(({ item, availability }) => <Card key={item.id} size="sm">
        <CardHeader><CardTitle>{item.name} <span className="text-app-caption text-app-text-muted">· {item.group}</span></CardTitle><p>{item.description}</p><p>{item.quick}</p>{!availability.available && <Badge variant="warning">{localizedReason(availability.reason)}</Badge>}</CardHeader>
        <CardContent><ol className="flex list-decimal flex-col gap-2 pl-5">{item.causes.map((cause) => <li key={`${cause.id}:${cause.label}`}><strong>{cause.label}</strong> <span className="text-app-text-muted">({cause.id})</span>: {cause.fix}{!cause.availability.available && <Badge className="ml-2" variant="warning">{localizedReason(cause.availability.reason)}</Badge>}<Button variant="link" size="sm" onClick={() => focus(cause.id)}>{m.lmu_setup_parameter_explanation()}</Button></li>)}</ol></CardContent>
      </Card>)}</TabsContent>
      <TabsContent value="requests" className="mt-3 flex flex-col gap-3">{presets.map(({ item, availability }) => <Card key={item.id} size="sm">
        <CardHeader><CardTitle>{item.name} <span className="text-app-caption text-app-text-muted">· {item.group}</span></CardTitle><p>{item.description}</p>{!availability.available && <Badge variant="warning">{localizedReason(availability.reason)}</Badge>}</CardHeader>
        <CardContent className="flex flex-col gap-2"><ul className="flex list-disc flex-col gap-2 pl-5">{item.targets.map((target, index) => <li key={`${target.section}.${target.key}.${index}`}><strong>{target.label}</strong> <span className="text-app-text-muted">({target.section}.{target.key})</span>: {target.delta === null ? m.lmu_setup_advice_evaluate() : `${target.delta > 0 ? "+" : ""}${target.delta} ${m.lmu_setup_clicks_suggestion()}`} {!target.availability.available && <Badge className="ml-2" variant="warning">{localizedReason(target.availability.reason)}</Badge>}</li>)}</ul><p className="text-app-caption text-app-text-muted">{m.lmu_setup_community_starting_point()}</p></CardContent>
      </Card>)}</TabsContent>
    </Tabs>
    <footer className="border-t border-app-border pt-3 text-app-caption text-app-text-muted">{m.lmu_setup_advice_attribution()} <a className="text-app-accent underline" href="/licenses/setup-ripple-MIT.txt" target="_blank" rel="noreferrer">{m.lmu_setup_license()}</a></footer>
  </div>;
}
