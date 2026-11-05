import { useQuery } from "@tanstack/react-query";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { Button } from "@/components/ui/button";
import { FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";

export function useCodexStatus() {
  return useQuery({
    queryKey: ["codex-status"],
    queryFn: async () => {
      const response = await client.api.codex.status.$get();
      if (!response.ok) throw new Error("Codex discovery failed");
      return response.json();
    },
    staleTime: 30_000,
    retry: false,
  });
}

export function CodexStatus() {
  const status = useCodexStatus();
  const state = status.data?.state;
  const message =
    state === "ready"
      ? m.ai_codex_ready()
      : state === "not-signed-in"
        ? m.ai_codex_login()
        : state === "cli-unavailable"
          ? m.ai_codex_missing()
          : state === "unsupported-runtime"
            ? m.ai_codex_unsupported()
            : m.ai_codex_unavailable();
  return (
    <FieldGroup className="mt-5 max-w-xl gap-2">
      <FieldLabel>Codex (ChatGPT)</FieldLabel>
      <FieldDescription role="status">{status.isFetching ? m.ai_settings_loading() : message}</FieldDescription>
      <FieldDescription>{m.ai_codex_help()}</FieldDescription>
      <Button variant="outline" size="sm" className="w-fit" disabled={status.isFetching} onClick={() => void status.refetch()}>
        {m.ai_refresh()}
      </Button>
    </FieldGroup>
  );
}
