import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { TuneSettings } from "@shared/types";
import type { TuneFormData } from "../../../components/TuneForm";
import { TuneForm } from "../../../components/TuneForm";
import { useUpdateTune } from "../../../hooks/queries";
import { client } from "../../../lib/rpc";

interface TuneResponse {
	id: number;
	name: string;
	author: string;
	carOrdinal: number;
	category: string;
	description: string;
	settings: TuneSettings | null;
}

function EditTunePage() {
	const { tuneId } = Route.useParams();
	const navigate = useNavigate();
	const updateTune = useUpdateTune();

	const { data: tune, isLoading } = useQuery({
		queryKey: ["tune", tuneId],
		queryFn: () =>
			client.api.tunes[":id"]
				.$get({ param: { id: String(tuneId) } })
				.then((r) => r.json() as unknown as TuneResponse),
	});

	if (isLoading)
		return (
			<div className="p-4 text-app-text-muted text-sm">Loading tune...</div>
		);
	if (!tune)
		return (
			<div className="p-4 text-app-text-muted text-sm">Tune not found</div>
		);

	const initialData: Partial<TuneFormData> = {
		name: tune.name,
		author: tune.author,
		carOrdinal: tune.carOrdinal,
		category: tune.category as TuneFormData["category"],
		description: tune.description,
		settings: tune.settings ?? undefined,
	};

	return (
		<div className="flex-1 overflow-auto p-4">
			<div className="max-w-6xl mx-auto">
				<TuneForm
					title={`Edit: ${tune.name}`}
					initialData={initialData}
					onCancel={() => navigate({ to: "/fm23/tunes" })}
					onSubmit={(data) =>
						updateTune.mutate(
							{ id: parseInt(tuneId), ...data } as Parameters<
								typeof updateTune.mutate
							>[0],
							{
								onSuccess: () => navigate({ to: "/fm23/tunes" }),
							},
						)
					}
					isSubmitting={updateTune.isPending}
				/>
			</div>
		</div>
	);
}

export const Route = createFileRoute("/fm23/tunes/edit/$tuneId")({
	component: EditTunePage,
});
