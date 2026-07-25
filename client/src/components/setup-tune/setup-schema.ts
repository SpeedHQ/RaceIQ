// The setup schema + nested-path helpers now live in shared/ so the server
// (tune generation, path validation) and the client form share one source.

export type { Arity, FieldDef, SectionDef } from "@shared/setup-schema";
export * from "@shared/setup-schema";
