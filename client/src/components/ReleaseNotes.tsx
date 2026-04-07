import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

function shortenGitHubLink(href: string, children: React.ReactNode) {
  if (typeof children === "string") {
    const prMatch = href.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    const compareMatch = href.match(/github\.com\/([^/]+\/[^/]+)\/compare\/(.+)/);
    if (prMatch) return `#${prMatch[2]}`;
    if (compareMatch) return compareMatch[2];
  }
  return children;
}

export function ReleaseNotes({ notes, className }: { notes: string; className?: string }) {
  return (
    <div className={`rounded border border-app-border bg-app-surface p-3 text-xs text-app-text-secondary leading-relaxed prose prose-sm prose-invert prose-headings:text-app-text prose-a:text-app-accent prose-a:underline ${className ?? ""}`}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {href ? shortenGitHubLink(href, children) : children}
            </a>
          ),
        }}
      >
        {notes}
      </Markdown>
    </div>
  );
}
