# Adding game setup support

Setup support extends an existing game integration. It is optional and is not required to complete [core game support](adding-new-game-support.md).

Apply this checklist when the game supports exporting setup files that RaceIQ can import. Document supported formats and versions; mark unsupported file workflows explicitly unavailable rather than substituting another game's format. Telemetry-derived setup snapshots alone do not prove file import/export support.

## Car setup import/export and experiments checklist

- [ ] **Import:** import a real game-exported setup through supported UI controls. Verify game, car, and track association where present, and reject malformed, unsupported-version, or wrong-game files with actionable errors.
- [ ] **View content:** open the imported setup and verify supported sections, parameter names, values, units, and click-index conversions against the original file. Unavailable fields remain explicit; no invented defaults presented as imported values.
- [ ] Complete the [bounds and AI validation checklist](setup-range-data.md#bounds-and-ai-validation-checklist) for every changeable setup value before enabling edits or generated setup files.
- [ ] **Edit:** change supported parameters through the setup editor, save, reopen, and reload. Verify changed values persist, valid ranges/steps are respected, and unrelated parameters remain unchanged.
- [ ] **Generate a new file:** export the edited setup as a new game-compatible file with the correct extension and format/version. Preserve required metadata and untouched source fields; do not overwrite the original setup.
- [ ] **File round trip:** re-import the generated file in isolated state and verify edits, unchanged values, and identity. Confirm the game accepts the generated file and applies the intended settings; RaceIQ accepting its own output alone is insufficient.
- [ ] **Experiments integration:** attach the imported setup as a base version in a matching game/car/track experiment. View its content, create an edited descendant, switch versions, and verify each version retains its own values after reload without mutating its parent.
- [ ] **Experiment file generation:** generate a setup file from the selected experiment version and re-import it. Verify file contents match that version—not the original base, another branch, or the current head when a different version is selected.
- [ ] **Experiment lap association:** associate matching laps with the intended setup version and verify they remain attached after version changes and reload. Reject mismatched game/car/track associations according to existing experiment rules.
- [ ] **Coverage:** add fixture-backed setup parser/serializer behavior coverage and browser E2E coverage for import → view → edit → generate file → re-import, plus the experiment version workflow. Record game-side file acceptance separately; automated round-trip coverage does not replace it.

Use existing [Setup Engineer version and experiment semantics](../architecture/setup-engineer.md) and [setup range data](setup-range-data.md).
