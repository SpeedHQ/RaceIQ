# Memory Index

- [user_profile.md](user_profile.md) — acoop: sim racer (FM/F1/ACC), SpeedHQ org, builds RaceIQ, prefers concise iteration
- [project_app_rename_raceiq.md](project_app_rename_raceiq.md) — App renamed to RaceIQ (2026-03-27) for multi-game support
- [project_f1_2025_support.md](project_f1_2025_support.md) — Multi-game adapter system: FM2023, F1 2025, ACC with registry pattern
- [project_ai_chat_mastra.md](project_ai_chat_mastra.md) — Mastra-based AI chat + analysis panel, dual providers, macOS Keychain keystore
- [project_track_data_sources.md](project_track_data_sources.md) — Track data extracted from FM2023 game files via LZX decompressor
- [project_track_segment_meta.md](project_track_segment_meta.md) — shared/tracks/meta/*.json is authoritative for segments; Spa historical segments; save requires gameId query param
- [project_analyse_ui_features.md](project_analyse_ui_features.md) — Track overlay cycling (none/inputs/segments/sectors), sector colors, sector time fallback, nav settings button
- [project_unit_middleware_refactor.md](project_unit_middleware_refactor.md) — Planned refactor: centralized unit conversion middleware replacing per-component useUnits()
- [project_udp_forwarder_extracted.md](project_udp_forwarder_extracted.md) — Rust UDP forwarder moved to SpeedHQ/udp-forwarder (2026-03-22)
- [project_steam_community.md](project_steam_community.md) — RaceIQ promoted on Steam Community with BBCode posts (2026-04-05)
- [project_known_test_failures.md](project_known_test_failures.md) — 3 ACC shared memory tests fail due to @libsql/client module resolution
- [feedback_canvas_rendering.md](feedback_canvas_rendering.md) — AnalyseTrackMap canvas pitfalls: offscreen caching, memoization, follow view zoom
- [feedback_git_workflow.md](feedback_git_workflow.md) — No git stash/pop mid-session; commit all related changes together in one commit
- [feedback_git_lfs_push.md](feedback_git_lfs_push.md) — Git LFS hooks block push on macOS; git-lfs not installed
- [feedback_no_game_fallback.md](feedback_no_game_fallback.md) — Never fall back to "fm-2023" when gameId is missing; make gameId required
- [feedback_no_dynamic_imports.md](feedback_no_dynamic_imports.md) — Prefer static `import` at top of file over `await import(...)`; don't copy existing dynamic-import patterns
- [feedback_bunx_over_npx.md](feedback_bunx_over_npx.md) — Always use bunx instead of npx for CLI tools (project uses Bun)
- [project_game_id_in_request_header.md](project_game_id_in_request_header.md) — gameId should travel via X-Game-Id header, not query params or effect-populated store
