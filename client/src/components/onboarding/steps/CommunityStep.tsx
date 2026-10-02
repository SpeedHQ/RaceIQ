import { SiDiscord, SiGithub } from "react-icons/si";
import { m } from "@/paraglide/messages";

export function CommunityStep() {
  return (
    <div className="flex flex-col items-center justify-center text-center py-6">
      <h2 className="text-2xl font-bold text-app-text mb-2 tracking-tight">{m.ob_community_title()}</h2>
      <p className="text-sm text-app-text-muted max-w-md leading-relaxed mt-2">{m.ob_community_body()}</p>
      <div className="flex items-center gap-4 mt-5">
        <a
          href="https://discord.gg/ZNXKyYPumT"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-lg border border-app-border bg-app-surface-alt px-4 py-2.5 text-sm text-app-text-secondary hover:border-app-accent hover:text-app-accent transition-colors"
        >
          <SiDiscord className="w-5 h-5" />
          {m.ob_discord()}
        </a>
        <a
          href="https://github.com/SpeedHQ/RaceIQ"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-lg border border-app-border bg-app-surface-alt px-4 py-2.5 text-sm text-app-text-secondary hover:border-app-accent hover:text-app-accent transition-colors"
        >
          <SiGithub className="w-5 h-5" />
          {m.ob_github()}
        </a>
      </div>
    </div>
  );
}
