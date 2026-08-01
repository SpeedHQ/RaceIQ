import type { ComponentProps } from "react";
import type { SortableTH, Table, TBody, TD, TH, THead, TRow } from "./AppTable";

type Assert<T extends true> = T;
type RejectsStyleOverrides<T> = T extends { className?: infer ClassName; style?: infer Style }
  ? Exclude<ClassName, undefined> extends never
    ? Exclude<Style, undefined> extends never
      ? true
      : false
    : false
  : false;
type OmitsLegacyOverride<T> = "tableClassName" extends keyof T ? false : "rowClassName" extends keyof T ? false : true;

export type TableStyleContract = Assert<RejectsStyleOverrides<ComponentProps<typeof Table>>>;
export type THeadStyleContract = Assert<RejectsStyleOverrides<ComponentProps<typeof THead>>>;
export type TBodyStyleContract = Assert<RejectsStyleOverrides<ComponentProps<typeof TBody>>>;
export type TRowStyleContract = Assert<RejectsStyleOverrides<ComponentProps<typeof TRow>>>;
export type THStyleContract = Assert<RejectsStyleOverrides<ComponentProps<typeof TH>>>;
export type SortableTHStyleContract = Assert<RejectsStyleOverrides<ComponentProps<typeof SortableTH>>>;
export type TDStyleContract = Assert<RejectsStyleOverrides<ComponentProps<typeof TD>>>;
export type LegacyOverrideContract = Assert<OmitsLegacyOverride<ComponentProps<typeof Table>> & OmitsLegacyOverride<ComponentProps<typeof THead>>>;
