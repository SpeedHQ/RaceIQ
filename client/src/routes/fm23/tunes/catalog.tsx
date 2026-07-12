import { Navigate, createFileRoute } from "@tanstack/react-router";

// The catalog + user tunes are unified into the main tunes browser at /fm23/tunes.
export const Route = createFileRoute("/fm23/tunes/catalog")({
  component: () => <Navigate to="/fm23/tunes" replace />,
});
