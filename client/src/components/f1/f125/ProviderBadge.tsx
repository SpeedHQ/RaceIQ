export function ProviderBadge({ provider }: { provider: string }) {
  if (provider === "f1laps")
    return (
      <span className="provider-badge px-1 py-0.5 text-app-nano font-bold uppercase rounded shrink-0" data-provider-brand="f1laps">
        F1L
      </span>
    );
  if (provider === "simracingsetup")
    return (
      <span className="provider-badge px-1 py-0.5 text-app-nano font-bold uppercase rounded shrink-0" data-provider-brand="simracingsetup">
        SRS
      </span>
    );
  return null;
}
