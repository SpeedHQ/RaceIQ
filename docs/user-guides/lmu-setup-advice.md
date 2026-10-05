# LMU setup advice and official knowledge

Open **LMU → Setups → Advice → Parameters**. Parameters with reviewed official coverage show a separate **Official LMU documentation** panel containing facts, source links and review dates. These summaries are bundled with RaceIQ and can be read offline; opening the original articles requires internet access.

## Coverage

The corpus in `packages/game-lmu-metadata/src/setups/official-knowledge.ts` contains six topics reviewed on 2026-10-04:

- Hybrid deployment and combined power.
- Regeneration and battery charge.
- Virtual Energy (NRG) as a stint allowance.
- Fuel carried relative to the allowance.
- Native LMGT3 ABS and car-specific maps.
- TC slip threshold, power cut and lateral slip target.

Sources:

- [Hypercar Category (LMH & LMDh)](https://guide.lemansultimate.com/hc/en-gb/articles/13152322265231-Hypercar-Category-LMH-LMDh)
- [What is Virtual Energy? (NRG)](https://guide.lemansultimate.com/hc/en-gb/articles/13152376674191-What-is-Virtual-Energy-NRG)
- [ABS (Anti-Lock Braking System) for LMGT3 Cars](https://guide.lemansultimate.com/hc/en-gb/articles/13211078435983-ABS-Anti-Lock-Braking-System-for-LMGT3-Cars)
- [How do I configure my traction control in Le Mans Ultimate?](https://guide.lemansultimate.com/hc/en-gb/articles/13182869047311-How-do-I-configure-my-traction-control-in-Le-Mans-Ultimate)

## Official facts versus tuning hypotheses

Official panels are reviewed paraphrases, not copies of entire articles. Community parameter effects, compensations, symptom causes and driver requests remain labelled starting points, not verified vehicle physics. Official documentation takes precedence where it contradicts a community heuristic.

A higher electric motor map spends battery charge faster; it replaces ICE torque rather than adding combined power. Fuel, NRG and battery charge are separate quantities. Fuel/NRG diagnosis remains available for non-hybrid and unidentified cars; hybrid-only causes remain unavailable unless hybrid capability is known.

ABS map numbers are not a universal more/less intervention scale. The corpus links to the official article's map diagram rather than inventing a numeric map conversion.

The corpus does not establish SVM click direction, physical ranges, setup bounds, deployment-speed thresholds for every car, or lap-time improvements. Confirm edits in LMU. Reviewed documentation can become outdated; the displayed review date is not a promise of automatic updates. Topic content is English, consistent with the existing community corpus; official-panel and review-date labels are localized.

## LMU experiments

Open **LMU → Experiments → New experiment** and choose a car and track. Setup-focused experiments start from a saved `.svm` in LMU's Settings folder. Driving-focused experiments can start without a setup; use **Add base** when you want to attach a saved setup later.

The version tree shows each saved setup and its lap evidence. **Setup** opens a read-only view of the six LMU setup pages; **Review** opens the version's lap review. History imports match LMU's canonical car and track identities, including distinct circuit layouts, rather than relying on discovered numeric ordinals.

With an AI provider configured, the engineer can inspect editable settings, preview click-index changes, and save a new sibling `.svm` after explicit confirmation. Fixed, derived, unknown, and capability-incompatible settings are not editable. Front, rear, left, right, and third-element controls retain distinct setting identities.

LMU exports do not establish upper click bounds or physical unit conversions. The engineer reports unknown bounds rather than inventing them; inspect proposed clicks and load the saved setup in LMU to confirm validity. Original files and unknown bytes are preserved, and a changed source file is refused instead of silently overwriting a newer setup.


## Updating the corpus

1. Read the original official article and any diagrams relevant to the proposed fact. Do not import forum claims as official facts.
2. Record a concise paraphrase, article title, canonical URL and the date the content was checked. Retain car/class and update-specific qualifications. Avoid treating changing BoP numbers as universal constants.
3. Add or update the topic's `parameterId` to match the existing setup parameter. Multiple topics can share a parameter, as ABS and TC do.
4. Correct conflicting advice in `knowledge.ts`. Reuse official summaries for authoritative explanations where appropriate; do not let a community recommendation silently become an official rule.
5. Exercise the affected advice through setup upload and the rendered official panel. Run metadata setup tests, locale-key validation and affected TypeScript checks. Add behavior regressions for applicability changes, not tests pinning wording.

No live crawler, remote retrieval, embeddings or AI-chat tool is involved. Expanding coverage requires reviewing and bundling additional official topics through this same process.

## Real setup test fixture

[`SECTORFLOW_DRY_LMP3DKR_FUJ_0904_V2_Q.svm`](../../packages/game-lmu-metadata/test/fixtures/SECTORFLOW_DRY_LMP3DKR_FUJ_0904_V2_Q.svm) is a user-supplied Ginetta G61LTP3 Evo / LMP3 setup, supplied on 2026-10-04. Its filename identifies a Fuji dry qualifying setup; that naming is not independent proof of track conditions or tuning quality.

The committed fixture retains all 5,232 original bytes, including CRLF line endings and the vehicle-path comment. SHA-256: `beb441e640d6eb7e7a1e646ea64e9bc90a82e947fe9c175a9c4b013fb95e2e01`. Git text conversion is disabled for these `.svm` fixtures.

`packages/game-lmu-metadata/test/setups/svm.test.ts` uses this full file to verify identity resolution, byte-identical no-op export, targeted wing and paired-pressure edits, exact restoration after reversing edits, and rejection of unavailable placeholder controls. The smaller synthetic fixtures remain for malformed input and encoding boundaries.

### Class coverage

| Class | Representative | Input |
| --- | --- | --- |
| Hypercar | Ferrari 499P | Explicitly synthetic SVM |
| LMP2 | Oreca 07 LM | Explicitly synthetic SVM |
| LMP3 | Ginetta G61LTP3 Evo | Unmodified user-supplied game export |
| GT3 | BMW M4 LMGT3 | Explicitly synthetic SVM |
| GTE | Porsche 911RSR-19 | Explicitly synthetic SVM |

Each class has codec coverage for identity resolution, targeted edits, unavailable-control rejection, and exact-byte restoration. Synthetic cases additionally exercise front-hybrid controls, native GT3 ABS, and fuel or Virtual Energy edits. Their numeric values are test inputs, not verified game setup ranges.

Real-export compatibility proof currently covers only the supplied LMP3 file. Real Hypercar, LMP2, GT3, and GTE exports are not included. Neither synthetic inputs nor this single real file establish physical click ranges, faster lap times, or coverage of every LMU car.
