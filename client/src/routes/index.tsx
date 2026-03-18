import { createFileRoute } from "@tanstack/react-router";

// LivePage is rendered persistently in __root.tsx to preserve state.
// This route exists so the router knows "/" is valid.
function EmptyLive() {
  return null;
}

export const Route = createFileRoute("/")({
  component: EmptyLive,
});
