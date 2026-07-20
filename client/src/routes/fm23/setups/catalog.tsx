import { createFileRoute, Navigate } from "@tanstack/react-router";

// The catalog + user tunes are unified into the main tunes browser at /fm23/setups.
export const Route = createFileRoute("/fm23/setups/catalog")({
  component: () => <Navigate to="/fm23/setups" replace />,
});
