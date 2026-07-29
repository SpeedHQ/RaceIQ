import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/f125/tunes/")({
  component: () => <Navigate to="/$gameid/tracks" params={{ gameid: "f125" }} search={{ tab: "setups" }} />,
});
