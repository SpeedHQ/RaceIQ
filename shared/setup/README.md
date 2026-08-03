# Setup presets

## Purpose
Static, human-maintained wheel-base and in-game setup recommendations.

This folder currently contains `fanatec-15nm.json`, a Forza Motorsport Fanatec 15 Nm profile with source links, wheel-base settings, in-game presets, per-car overrides, and usage tips.

## Data ownership
- Each JSON file is its own source of truth. No generator currently owns this folder.
- Keep citations in each file's `sources` array and keep recommendations attributable to those sources.
- Do not place simulator setup files here; ACC/AC Evo file contracts and form schema live in `shared/setups/`.
- Do not edit `shared/telemetry/catalog/generated/` when adding recommendation data; this folder is not a generated telemetry catalog input.

## Browser vs Node boundary
JSON files are static data without runtime code or environment-specific APIs. A browser or Node consumer may parse them, but loading, validation, and presentation belong to the consuming domain.

## Dependency direction
This folder depends on no runtime modules. Consumers may read a named JSON leaf; files here must not import app code or encode server-only paths.

## Add/extend safely
1. Add one stable, descriptive JSON file per hardware/profile combination.
2. Preserve the existing profile shape when extending the same dataset: identity, `sources`, `wheelBase`, base settings, in-game presets, overrides, and tips.
3. Cite primary or reputable sources and distinguish sourced values from explanatory guidance.
4. Add a consumer and validation at its owning boundary rather than introducing side effects here.

## Leaf imports (no barrel)
Reference a concrete data file. No barrel is provided or recommended.

```ts
import fanatec15Nm from "@shared/setup/fanatec-15nm.json";
```
