# Remove Cars-Page Race Results Card

## Scope
Remove the `RaceResultSummary` card titled `Race results across all cars` from the game cars route.

## Design
Update `client/src/routes/$gameid/cars.tsx` only:

- Remove the `RaceResultSummary` import.
- Remove the `<RaceResultSummary ... />` element from `CarsRoute`.
- Preserve the shared `RaceResultSummary` component and its home-page usage.
- Preserve all car-page variants and car data behavior.

## Verification
Run the targeted cars route test or the repository's frontend typecheck/build command. Confirm the route no longer renders the card and the home page still retains its race-results summary usage.
