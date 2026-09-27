import { useQueryClient } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { m } from "@/paraglide/messages";
import { queryKeys } from "@/hooks/query-keys";
import { client } from "@/lib/rpc";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

type FavoriteTarget = "lap" | "session";

export function FavoriteToggleButton({ target, id, isFavorite }: { target: FavoriteTarget; id: number; isFavorite: boolean }) {
  const queryClient = useQueryClient();
  const addLabel = target === "lap" ? m.sessions_add_lap_favorite() : m.sessions_add_session_favorite();
  const removeLabel = target === "lap" ? m.sessions_remove_lap_favorite() : m.sessions_remove_session_favorite();

  const toggleFavorite = async () => {
    const response = target === "lap"
      ? await client.api.laps[":id"].favorite.$patch({ param: { id: String(id) }, json: { favorite: !isFavorite } })
      : await client.api.sessions[":id"].favorite.$patch({ param: { id: String(id) }, json: { favorite: !isFavorite } });
    if (response.ok) await queryClient.invalidateQueries({ queryKey: target === "lap" ? queryKeys.laps : queryKeys.sessions });
  };

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="app-ghost"
              size="icon-xs"
              aria-label={isFavorite ? removeLabel : addLabel}
              onClick={(event) => {
                event.stopPropagation();
                void toggleFavorite();
              }}
            />
          }
        >
          <Star className={isFavorite ? "fill-current text-app-accent" : ""} aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent role="tooltip">{isFavorite ? removeLabel : addLabel}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
