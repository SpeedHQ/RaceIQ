# iRacing OAuth and iRating Tracker — implementation status

Implementation is underway using the agreed boundary in [contract](irating-tracker-contract.md), [backend plan](irating-tracker-backend-plan.md), and [UI plan](irating-tracker-ui-plan.md).

Decision: per-install OAuth client configuration. Client secrets and tokens use RaceIQ's OS credential store and remain backend-only. iRacing currently pauses new OAuth client registrations; existing registered clients can still be configured. See [iRacing client registration](https://oauth.iracing.com/oauth2/book/client_registration.html).

Completion requires compiled-app E1–E5 using isolated storage and deterministic upstream fixtures. Live OAuth/API E6 requires an existing registered OAuth client; do not report live-service verification without exercising it.
