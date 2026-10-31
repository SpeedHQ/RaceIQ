---
name: raceiq-online-shared-auth-dev-setup
description: "Set up SpeedHQ/online main with isolated dev data, existing Supabase/Discord auth, and an explicitly approved separate development tunnel."
---

# Shared-auth RaceIQ Online development

## Boundaries

Reuse hosted Supabase/Discord only when explicitly approved. Preserve production services, existing redirects, provider credentials and shared identities. Never run account-deletion tests against shared auth. Application SQLite/uploads remain isolated in `data/dev`. Expose a development tunnel only when requested; never publish private admin or metrics.

## Existing workflow

- Cloud checkout: `/Users/acoop/orca/projects/raceiq cloud`, origin `SpeedHQ/online`, branch `main`. Verify current checkout.
- `bun run dev` injects Infisical `dev` `/services`, then runs `scripts/dev-local.ts`. Native API/admin/processor share `data/dev/raceiq.sqlite` and uploads; Discord bot sends stay disabled.
- Check occupied ports. Supported overrides: `RACEIQ_DEV_API_PORT`, `ADMIN_DASHBOARD_PORT`. Current setup: API3100, dashboard3102, website3003, admin3001. Persist non-secret settings in ignored Cloud `.env`, preserving existing values.
- Desktop `.env.development` explicitly sets `RACEIQ_DEV_ONLINE_ORIGIN`, approved HTTPS `RACEIQ_DEV_AUTH_ORIGIN`, and public `RACEIQ_DEV_AUTH_PUBLISHABLE_KEY`. Never put a service-role key in desktop.
- Resolver allows loopback API or exact approved tunnel `https://raceiq-dev.snazzie.space`; production/arbitrary remote API origins remain rejected. Defaults disabled, exact-origin fetch/preconnect, redirect rejection, ephemeral dev keystore and strict E2E remain intact.

## Approved separate tunnel

- Existing `raceiq-dev` tunnel: `2f86d4b8-d664-4988-ba07-c42a8cc27a6e`; hostname `raceiq-dev.snazzie.space`. Inspect current state before creating anything. Do not modify production `raceiq-auth` tunnel.
- Run `cloudflared tunnel --config cloudflared.dev.yml run raceiq-dev` from Cloud checkout. Credentials resolve from operator's normal Cloudflare credential directory; never commit credential JSON.
- Dev ingress sends API/docs/health to loopback3100 and public website to loopback3003. No admin/dashboard/metrics upstream.
- Set Cloud `RACEIQ_DEV_PUBLIC_ORIGIN=https://raceiq-dev.snazzie.space`; set desktop API origin to same tunnel. API public URL and website browser API URL must use tunnel, not browser localhost. Internal API-to-website URL stays loopback3003.
- Restart only owned development stack after public-origin changes so website rebuilds with correct configuration. Keep requested stack/tunnel services persistent; do not install system daemons without approval.

## Redirect trap

Discord login does not prove Supabase accepts callback. Rejected redirects can silently fall back to `site_url` (observed localhost3000).

Read shared allowlist first. Append only required dev redirects; preserve existing entries, site URL and Discord settings. Desktop callback needs `<desktop-origin>/api/auth/discord/callback**`; website tunnel uses `https://raceiq-dev.snazzie.space/**`. Local admin stays local-only.

Verify a fresh real authorization attempt, then cancel via provider callback with its real state and `error=access_denied`. Check redirect origin/path only. Never log OAuth state or tokens.

## Verification

- Check public health200, website200, unauthenticated profile401, public admin/metrics404; check private service health locally.
- Confirm API/admin/processor use isolated development DB.
- Exercise actual desktop configured transport; assert tunnel succeeds and production origin is rejected before network.
- Exercise browser sign-in to existing Discord login form. Report user interactive completion separately.
- Dedicated test identity: follow `raceiq-online-isolated-qualification` lease/secret handling. Hosted auth, real SDK identity and private preference write/read through dev API/tunnel only. Logout only test session with `scope=local`.
- Run focused resolver tests and both repository typechecks. Missing native Prometheus is monitoring limitation.

## Management credentials

CLI profile may be `supabase`, not legacy `access-token`; resolve through bounded debug output. macOS namespace `Supabase CLI` may store `go-keyring-base64:` envelope. Decode in memory only. GET/PATCH Management API auth config, changing only `uri_allow_list`; never push full fixture config onto shared provider. Clear temporary credential references.
