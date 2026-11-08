# HTTP contracts

## Purpose
Reusable request-boundary schemas for route parameters and query strings.

`route-schemas.ts` centralizes common Zod parsing so routes reject invalid identifiers consistently and consume typed validator output.

## Schemas and output keys
- `IdParamSchema`: path-param object with output key `id`; transforms string input with base-10 `parseInt` and requires an integer result.
- `CarIdParamSchema`: path-param object with nonempty string output key `carId`; preserves native names and numeric game IDs represented as strings.
- `TrackIdParamSchema`: path-param object with nonempty string output key `trackId`; preserves native IDs, including AC Evo JSON `[trackName, trackConfiguration]` tuples.
- `IdVersionParamSchema`: path-param object with output keys `id` and `versionId`; transforms both with base-10 `parseInt` and requires integer results.
- `GameIdQuerySchema`: query object with optional output key `gameId`, validated by `shared/games/ids.ts`.

Output-key ownership matters: schema keys must match both route placeholder/query names and `c.req.valid("param" | "query")` destructuring. Use `:carId` with `CarIdParamSchema` and `:trackId` with `TrackIdParamSchema`. URL-encode native IDs when constructing URLs; Hono decodes path parameters before validation.

## Browser vs Node boundary
Schemas are environment-neutral TypeScript and Zod. They contain no Hono, DOM, Node, database, or transport setup. Current consumers are server Hono routes, which own validator wiring and HTTP error translation.

## Dependency direction
- `shared/platform/http/route-schemas.ts` depends only on Zod and `shared/games/ids.ts`.
- Server routes depend on this leaf module and bind schemas with their route validator.
- Shared HTTP schemas must not import route handlers, server services, persistence, or client state.

## Add/extend safely
- Add a shared schema only when multiple routes use the same input shape and coercion semantics.
- Make input key, transformed output key, and route placeholder/query name explicit and consistent.
- Keep domain payload validation in its owning route/domain unless genuinely shared across boundaries.
- Preserve existing coercion behavior unless changing the public route contract intentionally; `parseInt` semantics differ from strict numeric-string validation.
- Routes remain responsible for choosing `"param"`, `"query"`, `"json"`, or `"form"` validation target and for consuming only the corresponding typed output.

## Leaf imports (no barrel)
Use direct file imports only.

```ts
import {
  GameIdQuerySchema,
  IdParamSchema,
  IdVersionParamSchema,
  CarIdParamSchema,
  TrackIdParamSchema,
} from "@shared/platform/http/route-schemas";
```
