import { createFileRoute } from "@tanstack/react-router";
import { ImportDumpPanel } from "../../components/dev/ImportDumpPanel";

export const Route = createFileRoute("/dev/import")({
  component: ImportDumpPanel,
});
