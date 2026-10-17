import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getAllGames } from "@raceiq/shared/games/registry";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { client } from "@/lib/rpc";
import { clientReleaseFeatures } from "@/lib/release-features";
import { m } from "@/paraglide/messages";
import type { IRacingCaptureStatus } from "../../../../../apps/backend/src/runtime/iracing-capture";


const queryKey = ["iracing-capture-status"];

function stateLabel(state: IRacingCaptureStatus["state"]): string {
  switch (state) {
    case "unavailable": return m.settings_iracing_state_unavailable();
    case "disconnected": return m.settings_iracing_state_disconnected();
    case "waiting-for-iracing": return m.settings_iracing_state_waiting_iracing();
    case "waiting-for-recording": return m.settings_iracing_state_waiting_recording();
    case "recording": return m.settings_iracing_state_recording();
    case "saving": return m.settings_iracing_state_saving();
    case "error": return m.settings_iracing_state_error();
  }
}

function reasonLabel(reason: NonNullable<IRacingCaptureStatus["reason"]>): string {
  switch (reason) {
    case "unsupported-platform": return m.settings_iracing_reason_unsupported();
    case "feature-disabled": return m.settings_iracing_reason_feature_disabled();
    case "documents-unavailable": return m.settings_iracing_reason_documents();
    case "sdk-command-failed": return m.settings_iracing_reason_sdk();
    case "archive-failed": return m.settings_iracing_reason_archive();
  }
}

export function IRacingConnection() {
  const queryClient = useQueryClient();
  const enabled = clientReleaseFeatures.iracingAdapter && getAllGames().some((game) => game.id === "iracing");
  const query = useQuery({
    queryKey,
    enabled,
    queryFn: async () => {
      const response = await client.api.iracing.capture.$get();
      if (!response.ok) throw new Error(String(response.status));
      return await response.json();
    },
    refetchInterval: 2000,
  });
  const mutation = useMutation({
    mutationFn: async (connected: boolean) => {
      const response = await client.api.iracing.capture.$put({ json: { connected } });
      if (!response.ok) throw new Error(String(response.status));
      return await response.json();
    },
    onSuccess: async (status) => {
      queryClient.setQueryData(queryKey, status);
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: async () => { await queryClient.invalidateQueries({ queryKey }); },
  });

  if (!enabled) return null;

  const status = query.data;
  return (
    <Card className="mt-6 max-w-2xl">
      <CardHeader>
        <CardTitle>{m.settings_iracing_title()}</CardTitle>
        <CardDescription>{m.settings_iracing_description()}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Alert>
          <AlertTitle>{m.settings_iracing_opt_in_title()}</AlertTitle>
          <AlertDescription>{m.settings_iracing_opt_in_description()}</AlertDescription>
        </Alert>
        <div className="flex flex-wrap items-center gap-3">
          {status && <Badge variant={status.state === "recording" ? "success" : status.state === "error" ? "danger" : "neutral"} aria-live="polite">{stateLabel(status.state)}</Badge>}
          {status?.connected && <span className="text-sm text-muted-foreground">{m.settings_iracing_armed()}</span>}
        </div>
        {query.isError && <Alert variant="destructive" role="alert"><AlertTitle>{m.settings_iracing_query_error_title()}</AlertTitle><AlertDescription>{m.settings_iracing_query_error()}</AlertDescription></Alert>}
        {mutation.isError && <Alert variant="destructive" role="alert"><AlertTitle>{m.settings_iracing_mutation_error_title()}</AlertTitle><AlertDescription>{m.settings_iracing_mutation_error()}</AlertDescription></Alert>}
        {status && !status.supported && <Alert variant="destructive"><AlertTitle>{m.settings_iracing_unavailable_title()}</AlertTitle><AlertDescription>{status.reason ? reasonLabel(status.reason) : m.settings_iracing_reason_unsupported()}</AlertDescription></Alert>}
        {status?.state === "error" && status.reason && <Alert variant="destructive" role="alert"><AlertTitle>{m.settings_iracing_state_error()}</AlertTitle><AlertDescription>{reasonLabel(status.reason)}</AlertDescription></Alert>}
        {status && <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div><dt className="font-medium">{m.settings_iracing_source_directory()}</dt><dd className="break-all text-muted-foreground">{status.sourceDirectory ?? m.settings_iracing_not_available()}</dd></div>
          <div><dt className="font-medium">{m.settings_iracing_archive_directory()}</dt><dd className="break-all text-muted-foreground">{status.archiveDirectory}</dd></div>
          <div><dt className="font-medium">{m.settings_iracing_saved_count()}</dt><dd className="text-muted-foreground">{status.savedFiles}</dd></div>
          <div><dt className="font-medium">{m.settings_iracing_last_file()}</dt><dd className="break-all text-muted-foreground">{status.lastSavedFile ?? m.settings_iracing_none()}</dd></div>
        </dl>}
        <p className="text-xs text-muted-foreground">{m.settings_iracing_local_files_note()}</p>
      </CardContent>
      <CardFooter>
        <Button type="button" aria-busy={query.isLoading || mutation.isPending} disabled={query.isLoading || query.isError || mutation.isPending || !status?.supported} onClick={() => mutation.mutate(!status?.connected)}>
          {query.isLoading || mutation.isPending ? m.settings_iracing_pending() : status?.connected ? m.settings_iracing_disconnect() : m.settings_iracing_connect()}
        </Button>
      </CardFooter>
    </Card>
  );
}
