# CyberGrid: Review and Improvement Plan

Date: 2026-10-20  
Status: Implementation brief  
Companion: [Coding-agent prompt](cybergrid-implementation-prompt.md)

## 1. Recommendation

CyberGrid has a distinctive premise and a working MVP: a terminal-driven hacking game in which puzzles, extraction, cleanup, and escape compete for a limited trace budget. Its separate TypeScript engine is a useful foundation for expanding the game without tying rules to React.

The next work should follow three priorities:

1. **Make the first complete play session reliable and readable.** Repair terminal input, persistence, resume, puzzle guidance, and misleading outcomes. Add tests that exercise actual keyboard interaction.
2. **Make missions offer meaningful choices.** Introduce branching networks, alternative objectives, optional rewards, and a small number of clearly explained mission modifiers.
3. **Give progression and replay a stronger purpose.** Add equipment tradeoffs, rank unlocks, a campaign ending, reproducible challenges, and local personal records.

Deliver these as sequential, independently working increments. The required scope is the findings F01–F12 and enhancements E01–E07 below. Section 10 lists future ideas outside this implementation scope.

### 1.1 Required product direction: fun comes first

**CyberGrid is a text-heavy hacking game whose primary goal is to be very enjoyable to play.** This applies to the whole experience: UI/UX, functionality, command interaction, puzzles, mission structure, writing, audio/visual feedback, pacing, difficulty, and progression. Technical correctness supports that goal; it is not a substitute for enjoyable play.

Preserve the fantasy of operating a burner terminal, taking contracts from the Broker, uncovering secrets, outsmarting defenses, and escaping with a rising trace. The terminal, expressive text, and player decisions should carry the experience. Supporting panels should help the player act within that fantasy. A conventional dashboard or management interface must not become the organizing model for the game.

Required experience principles:

- **Satisfying interaction:** Commands produce immediate, understandable responses. Typewriter effects, sound, and motion add character while remaining skippable, optional where appropriate, and respectful of accessibility settings.
- **Rich text with good pacing:** Use atmospheric terminal output, clues, discoveries, and distinctive Broker dialogue. Keep time-critical information concise and scannable. Let players choose to read longer lore; do not inflate text volume with repetitive instructions or walls of exposition.
- **Interesting decisions:** Routes, tools, puzzles, optional loot, and escape timing create understandable tradeoffs. Each major enhancement should add a recognizable enjoyable moment or meaningful decision.
- **Fair tension:** Signal risk before commitment, explain failure afterward, and keep recovery options legible. Difficulty should come from decisions and puzzles, with command assistance reducing accidental typing friction.
- **Flow and variety:** Teach through short interactive successes, introduce new situations gradually, and avoid stretches of repetitive file handling, mandatory grind, or waiting for presentation effects.
- **Rewarding progression:** Celebrate earned mastery, provide equipment with distinct play styles, and make another run appealing through new decisions and discoveries. More screens, counters, or features do not automatically improve the game.
- **Coherent UI/UX:** Make trace, objectives, active locks, and escape options easy to read without crowding out the terminal. Keep keyboard play comfortable and small-screen controls usable.

Before marking each phase complete, assess what changed in the player's moment-to-moment experience. Perform a browser playthrough where possible, record friction and pacing observations, and refine what feels tedious or unclear. Assess the tutorial, ordinary missions, a tense escape, failure/retry, and the progression/replay loop. Report agent observations honestly; claims about human enjoyment or retention still require player research.

These principles guide every required finding and enhancement. They do not add a backend, a new genre, or the optional future backlog to the implementation scope.

## 2. Review scope and evidence

Reviewed the README, PRD v2, engine, mission generator, puzzles, validation, save schema, React HUD, terminal input/output, bridge, styles, and existing tests.

Checks completed during the review:

| Check | Result |
| --- | --- |
| `npm test` | Passed: 71 engine tests and 4 bridge tests |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| Production bundle | Approximately 644 kB JavaScript before gzip, 182 kB gzip; Vite reported its large-chunk warning |
| Targeted engine checks | Reproduced save, resume, reward, clue, seed, and campaign-ending issues |
| Terminal keyboard check | Executed the component's keyboard handler with mocked UI dependencies; typed commands were replaced by `retry` on the results screen |

This was a source review and headless verification. A live browser playtest, assistive-technology audit, device-performance benchmark, and human difficulty study were not performed. Proposed benefits to enjoyment and retention are hypotheses to validate with players.

The existing perfect-run simulation completed all ten fixed contracts. That establishes a successful scripted route under the simulator's assumptions; it does not establish human completion rates.

### Current architecture

- `packages/engine`: framework-independent TypeScript rules, generation, puzzles, virtual filesystem, economy, state, and persistence.
- `app`: React/Vite interface, xterm.js terminal, Web Audio synthesis, and localStorage adapter.
- Engine interaction: `submit(command)`, `tick(seconds)`, `getState()`, and `serialize()`.
- Ten fixed contracts, custom seeds, three puzzle families, six permanent shop upgrades, and local saves.
- Mission topology is a linear chain. Campaign objectives require stealing a configured number of flagged files.

## 3. Findings and required fixes

Severity describes player impact. Findings marked **reproduced** were exercised during this review; **source-confirmed** findings describe code behavior or a verification gap without claiming a browser reproduction.

### F01 — Results-screen input prevents normal progression

**Severity:** Critical. **Evidence:** Reproduced keyboard-handler behavior.

Source: [`TerminalView.tsx`](../app/src/terminal/TerminalView.tsx), `attachCustomKeyEventHandler`, post-mode Enter branch.

**Reproduction:** Finish or exit a contract, type `contracts`, and press Enter. The handler submits `retry`. The same occurs for `run 2` and `settings mute on`.

**Cause:** The post-mode Enter shortcut runs before normal submission and does not check whether the input is empty. It also leaves the typed input buffer uncleared.

**Required change:** Treat empty Enter as retry. Submit nonempty input normally, clear its buffer, and preserve command history behavior.

**Acceptance:**

- Empty Enter retries the same mission configuration.
- `contracts`, `run 2` after unlocking, `profile`, and settings work from results.
- TAB followed by Enter executes the displayed suggestion.
- Text typed before leaving results does not appear in the next mission's input.
- A real keyboard-driven test reaches contract 2 without reloading the application.

### F02 — Saving can erase an unresumed session

**Severity:** High. **Evidence:** Reproduced serialization behavior; source-confirmed blur trigger.

Sources: [`game.ts`](../packages/engine/src/game.ts), constructor, `serialize`, `persist`; [`App.tsx`](../app/src/App.tsx), blur persistence.

**Reproduction:** Save an active mission, reload to the home terminal, and serialize before selecting `resume`. The output contains `session: null`, although the engine still holds a pending session. Blur or a settings save can persist that null value; a later reload loses the run.

**Required change:** Preserve the pending session in serialization until it is resumed, explicitly abandoned, or deliberately replaced. Loading home, changing settings, blurring, and reloading must not discard it. Starting another mission while a recoverable session exists must require an explicit abandon/replacement command, with useful guidance.

**Acceptance:** Two consecutive reloads, with blur or settings changes between them, preserve the same recoverable run. `abandon` intentionally clears it and persists that decision. This is an in-game data-loss safeguard, not a requirement to ask the developer for approval.

### F03 — Resume restores only part of the running game

**Severity:** High. **Evidence:** Timer, tutorial guidance, and run-counter changes reproduced; additional missing fields source-confirmed.

Sources: [`game.ts`](../packages/engine/src/game.ts), `startMission`, `snapshotSession`, `restoreSession`, `cmdResume`; [`types.ts`](../packages/engine/src/types.ts), `SessionSave`.

Observed problems:

- A level-2 crowbar lock had a 46-second fuse before saving and a 30-second fuse after resume.
- A tutorial waiting for `download ledger.dat` resumed with `scan` guidance and rejected the intended next command.
- Resuming incremented `runsStarted` from 1 to 2.
- The schema does not persist the current directory, tutorial step, elapsed mission time, first-breach timing, or trace breakdown. Fuse-warning state also resets.

**Required change:** Define a complete serializable mission state. Restore gameplay position, objective progress, equipment/loadout, effective puzzle limits, puzzle input, transfer progress, watchdog/decoy timers, tutorial position, elapsed active time, and debrief accounting. Restore guidance from that state. Count resume as continuation, not a new attempt.

Pending scan/breach animations need an explicit policy: serialize a small action descriptor, or resolve/cancel the presentation delay safely and tell the player what to do. Never serialize closures.

**Acceptance:** Save/restore checkpoints throughout the tutorial and every puzzle family; resume an upgraded fuse near expiry and a partial transfer; preserve the working directory and trace breakdown; verify no duplicate payout, run count, or first-breach sample. Do not count time spent with the application closed as mission time.

### F04 — Cipher guidance points to an inaccessible clue

**Severity:** Medium. **Evidence:** Reproduced.

Sources: [`missions.ts`](../packages/engine/src/missions.ts), cipher plaque generation; [`game.ts`](../packages/engine/src/game.ts), lock command allowlist and breach instructions.

**Reproduction:** Open a cipher lock. The game suggests reading `plaque.txt`, but that file lives on the unbreached target node, and the active lock rejects `cat`.

**Required change:** Provide a reachable pre-breach clue. Recommended default: put the shift clue on an already accessible predecessor node and expose its location through recon; allow read-only clue inspection during a lock. For branching missions, make the clue reachable from either valid approach. Do not put the plaintext solution on the public clue plaque.

**Acceptance:** A player can obtain and use the clue through ordinary commands before solving the lock. Cipher decoding, paid hints, skip, and disconnect remain available. Update the manual and tutorial-facing copy to match.

### F05 — Empty runs earn clean-exit XP; early outcomes are ambiguous

**Severity:** Medium. **Evidence:** Empty-run reward reproduced; HUD mismatch source-confirmed.

Sources: [`game.ts`](../packages/engine/src/game.ts), `finishMission`; [`Hud.tsx`](../app/src/hud/Hud.tsx), result rendering.

**Reproduction:** Repeat `run 1` followed immediately by `disconnect` six times. The player earns 300 XP and Operator rank with zero stolen files and zero cleared contracts.

The terminal distinguishes an early extraction, but the result model records `clean` or `messy` independently of completion and the HUD displays a successful-looking exit label.

**Required change:** Separate objective completion from exit quality in the result model. Award the clean-completion XP bonus only when the objective is completed. Preserve legitimate earned XP/loot on partial runs according to documented rules. Show `EXTRACTED EARLY` consistently in the terminal, HUD, records, and analytics. Keep ordinary replay rewards; do not replace the economy wholesale.

**Acceptance:** Empty runs earn zero XP and cash. Partial extraction cannot clear a contract or earn its completion bonus. Successful clean, successful hot, early, and busted results have distinct, consistent summaries. Verify threshold behavior just below and at 50% trace using authoritative values, not rounded display numbers.

### F06 — Displayed seeds do not reproduce the displayed mission

**Severity:** Medium. **Evidence:** Reproduced.

Sources: [`rng.ts`](../packages/engine/src/rng.ts), `formatSeed`; [`game.ts`](../packages/engine/src/game.ts), custom seed difficulty selection and validated mission lookup; [`validate.ts`](../packages/engine/src/validate.ts), deterministic redraws.

**Reproduction:** Contract 1 uses `CG-OMEN-01` but displays `CGOM-EN01`. Passing the displayed value back to generation produces a different network. Formatting also truncates longer inputs. Custom seed difficulty currently depends on campaign progress, so a bare seed is not a complete mission identity.

**Required change:** Keep decorative labels separate from exact replay/share data. Define a versioned share code containing the original generation input, fixed difficulty, generation/rules version, objective/topology selection where relevant, and any comparison rules. Replay must use that identity independently of profile progression. Deterministic redraws must not cause a second redraw when retrying an already resolved mission.

**Acceptance:** Copy/share/import round-trips reproduce nodes, edges, objectives, answers, and modifiers across profiles with different progress. Test long, mixed-case, punctuation-containing, and Unicode seeds; malformed and unsupported-version codes; and a seed that requires validator redraw. Retry and resume reproduce the original configuration. Show the exact code through a small command such as `share`.

### F07 — Campaign completion suggests a nonexistent contract

**Severity:** Low. **Evidence:** Reproduced.

Source: [`game.ts`](../packages/engine/src/game.ts), `printContracts`.

**Reproduction:** With ten contracts cleared, open the board. Its next suggestion is `run 11`, which is rejected.

**Required change:** Add an explicit completion state, a short Broker ending, and valid replay/challenge suggestions. Show the ending once without preventing later access.

**Acceptance:** Completing contract 10 produces a finish state. Subsequent board visits and reloads never suggest an out-of-range contract, relock cleared contracts, or replay the ending unexpectedly.

### F08 — Panic tools are blocked during active locks

**Severity:** Medium design/interaction issue. **Evidence:** Reproduced for `proxy`; source-confirmed for `decoy`.

Source: [`game.ts`](../packages/engine/src/game.ts), lock command allowlist.

**Required change:** Allow proxy and decoy commands and their supported aliases during locks, while preserving the existing rules for charges and watchdog relevance. They must not answer, restart, or dismiss the puzzle. Expose the available actions in the puzzle panel.

**Acceptance:** Proxy reduces trace and consumes one charge during a lock. Decoy works when a watchdog exists. Rejected actions consume nothing. Puzzle elapsed time and entered knock steps remain intact; trace thresholds and bust behavior remain correct.

### F09 — Narrow layouts and keyboard accessibility need explicit support

**Severity:** Medium usability gap. **Evidence:** Source-confirmed; browser impact needs verification.

Sources: [`styles.css`](../app/src/styles.css), fixed 250px/290px side columns and no viewport-width breakpoints; [`Hud.tsx`](../app/src/hud/Hud.tsx), clickable node `div`s; [`TerminalView.tsx`](../app/src/terminal/TerminalView.tsx), keydown-centered input.

**Required change:** Provide a compact layout with accessible map/objective drawers, semantic keyboard-operable node controls, visible focus states, and a usable command input at narrow widths. Test paste, IME composition, and virtual keyboards; a native input fallback may share the same command submission/completion path. Keep the terminal aesthetic and reduced-motion/mute settings.

**Acceptance:** At 390px, 768px, and 1280px widths, trace, objective, active lock, and command entry remain usable without page-level horizontal overflow. A keyboard user can inspect nodes and return to command entry. Dynamic status is available as text without announcing every animation frame. Verify at 200% zoom. Do not advertise complete screen-reader support without testing it.

### F10 — Tests do not establish browser correctness or human balance

**Severity:** Medium verification gap. **Evidence:** Source-confirmed.

Sources: [`bridge.test.ts`](../app/src/bridge.test.ts), [`validate.ts`](../packages/engine/src/validate.ts), [`config.ts`](../packages/engine/src/config.ts).

Current UI tests have no DOM or keyboard coverage. The perfect-run validator reads the generator's answer key and advances little thinking time; the configured `secondsPerBreach`, `secondsPerDownload`, and `secondsPerMisc` are not used by that simulation. Its final exhausted fallback returns an unvalidated mission, despite the documented guarantee.

**Required change:** Add targeted real-browser journeys, complete persistence regressions, and deterministic balance scenarios with action/thinking delays and mistakes. Keep an oracle solver for structural validation, but label its assumptions accurately. Validate the fallback too; if all candidates fail, return a verified safe template or a recoverable typed error. Track actual peak and final trace separately.

**Acceptance:** Exercise all ten contracts and a bounded corpus of custom seeds, graph variants, objectives, modifiers, and loadouts. Check peak trace stays below bust and final trace meets the configured margin for the appropriate policy. Scenarios include cautious first-time play and one recoverable mistake; report results without presenting them as measured human completion rates. Validator failure never starts an unverified job or freezes the UI.

### F11 — Maintainability and load performance need bounded improvements

**Severity:** Low engineering concern. **Evidence:** Source-confirmed file size and build warning; no measured runtime regression.

Sources: [`game.ts`](../packages/engine/src/game.ts), approximately 2,406 lines at review; [`App.tsx`](../app/src/App.tsx), frame-driven snapshots; [`vite.config.ts`](../app/vite.config.ts).

**Required change:** Extract persistence/migration, objective evaluation, scoring/results, and mission identity logic as those areas change. Keep public engine APIs stable where practical. Profile snapshot creation and rendering before optimizing. Assess a separate/lazy WebGL addon chunk or another justified split, and document measured initial payload effects. Moving code to another eagerly loaded chunk alone does not establish faster loading.

**Acceptance:** No gameplay rules move into React. No extra dependency is added without a clear purpose. Existing boot and terminal rendering remain reliable; changes include a before/after build comparison. Treat the chunk warning as an optimization signal, not a broken build.

### F12 — Documentation contradicts the shipped application

**Severity:** Low. **Evidence:** Source-confirmed.

Source: [`README.md`](../README.md).

The README describes the shipped shop, but also lists the upgrade shop as cut/Phase 2. Its recorded engine test count is outdated.

**Required change:** Update setup, features, commands, save compatibility, mission identity, test instructions, and shipped-versus-future scope after implementation. Preserve the original PRDs as historical design documents; clearly identify this plan and the final implementation notes as subsequent decisions.

## 4. Required enhancements

These are proposed product changes, not defects in features that already shipped. The defaults below make the work actionable; tuning numbers remain centralized in configuration.

### E01 — A readable active-game interface

Implement a persistent lock panel with the puzzle prompt, family, countdown, attempts, and relevant help/hint/skip/tool commands. Hide a knock sequence after its reveal window and label it as a memory challenge; existing terminal scrollback can remain available, as accepted in the MVP. Do not silently claim that the scrollback copy is erased.

Show trace percentage, escalation state, current source/rate of trace growth, and clean-exit threshold. Show transfer progress and operation type independently of scrolling text. Distinguish the required objective from optional loot.

Preserve command-driven gameplay: inspecting a node must not automatically breach or download. If a HUD action helps compose a command, it must not execute the command unexpectedly.

**Acceptance:** A player can identify the active objective, remaining fuse, available escape tools, and next valid action from the visible screen. The panel always reflects engine state after timeout, skip, resume, and bust. Avoid duplicate contradictory handler instructions.

### E02 — Branching networks and alternate objectives

Replace array-index adjacency with explicit node IDs and edges. Support both a chain and a small fork-and-rejoin topology. Recon and the map must show real connections, reachable nodes, security, expected breach cost, known clues, and optional rewards.

Default first branching scenario: two approaches lead to the same objective. One has more lower-security locks; the other has fewer, hotter locks. An optional vault branch offers extra loot and consumes trace. Both approaches must be playable; one must not always dominate under all supported equipment choices.

Keep contracts 1–3 as introductory chains. Introduce branching and new objectives gradually in later contracts. Keep the original ten contract IDs and cleared progress. Version generation so older saved missions remain reproducible.

Support three objective types through shared, data-driven evaluation:

| Objective | Required behavior |
| --- | --- |
| Flagged-file extraction | Preserve the current collect-required-files loop |
| Dossier extraction | Extract the specific designated dossier, with other files optional |
| Payload placement | Deliver a mission-provided local payload to a designated remote node/path using an `upload` command |

An upload should use the same transfer/timing framework as a download, with configurable trace costs. Completion must depend on the objective, not on a hardcoded download count. Hints and instructions explain new operations at their first appearance.

**Acceptance:** Adjacency, scan output, watchdog movement, owned-node travel, autocomplete, map rendering, retries, resume, scoring, and validation use the same graph/objective data. Required paths and clue locations are reachable. No duplicated or overlapping files make an objective impossible. Repeated upload cannot duplicate rewards.

### E03 — Progression with equipment choices

Preserve cash, XP, ranks, existing six permanent upgrades, and previous purchases. Add one optional equipment-module slot, chosen at home and fixed for the run. Provide concise `loadout` and `equip` commands, including an unequip option.

Initial modules:

| Module | Unlock | Transfer-duration multiplier | Transfer-trace-rate multiplier | Intended tradeoff |
| --- | --- | --- | --- | --- |
| Burst uplink | Operator | 0.80 | 1.50 | Faster transfers, about 20% more total transfer trace |
| Quiet uplink | Breacher | 1.25 | 0.60 | Slower transfers, about 25% less total transfer trace |

These factors compose with permanent overclock upgrades. The slot is optional, modules do not erase purchased benefits, and the defaults are tuning inputs rather than hardcoded rules. Show effective values before starting a job. Keep modules free once unlocked for this iteration to avoid adding another grind requirement.

Differentiate campaign, custom/practice, and daily modes in the mission identity and reward policy. Proposed default: custom/practice jobs may earn documented ordinary rewards but do not mark a specific canonical campaign contract as cleared. Only campaign completion advances the campaign. Fixed daily equipment overrides personal advantages for comparable records.

**Acceptance:** Rank unlocks appear at valid earned milestones; equipping mid-mission is rejected without side effects; reload preserves equipment; resumed runs keep their original loadout; completed records identify the loadout. Both modules have measurable benefits and costs.

### E04 — Campaign ending and local mastery records

Add a short campaign-ending exchange after contract 10, completion status, and valid actions for replay, custom missions, and daily challenge. Add brief mission-specific Broker introductions/debriefs for the new objectives without creating a long narrative campaign.

Store local personal bests by complete mission identity and comparable rules/loadout. Display objective completion, exit quality, earned cash, active elapsed time, final trace, and date. Keep a small bounded recent history.

For a single comparable best result, use deterministic ordering: completed objective first; then clean exit over hot exit; then greater payout; then lower final trace; then shorter active duration. Preserve an earlier result on an exact tie. Do not compare records across rules versions or incompatible loadouts.

**Acceptance:** Results are saved once, survive reload, remain bounded, and cannot be improved by repeatedly opening a results screen. Early and busted runs never outrank completed runs. Provide a useful `records` command.

### E05 — Reproducible daily challenge

Implement a local daily challenge using UTC date, an explicit generation/rules version, a fixed tier, and a fixed equipment profile. Use an introductory mid-tier difficulty by default and document the configured choice. Every player on the same rules version receives the same mission regardless of rank, local timezone, or purchases.

The first attempt for the UTC date is the recorded daily attempt. Persist attempt start immediately, permit resume after interruption, and do not reset eligibility on reload. Later attempts are labeled practice and cannot overwrite that day's recorded attempt. Other local records may still track practice separately.

This is a local honor-system feature. It does not establish global ranking, authoritative anti-cheat, or cross-device synchronization.

**Acceptance:** Test UTC midnight boundaries with an injected clock, different local timezones, reload during a run, attempt abandonment, replay as practice, and different player profiles. A run keeps the date/rules identity it started with even after midnight. `daily` and share/import paths use the same mission descriptor.

### E06 — Controlled mission modifiers

Add two deterministic, clearly announced modifiers after the basic graph and objectives work:

- **Noisy link:** higher transfer trace rate with a disclosed additional completion reward.
- **Active patrol:** faster watchdog movement with a disclosed additional completion reward.

Default to at most one modifier per mission. Introduce modifiers after introductory contracts. Keep their numbers in configuration and include them in saves, share codes, solver scenarios, and records.

**Acceptance:** Recon and briefing disclose the effect. The reward applies once on successful completion. The validator checks modified costs. No modifier disables the only route, removes access to necessary clues, or silently changes tutorial rules.

### E07 — Useful local feedback and tuning

Repair resume-related counters and preserve local-only telemetry. Extend `stats` with outcomes by contract/objective, puzzle failures by family, time to first breach, and use of proxy/decoy/hint/skip. Keep storage bounded and exclude tutorial activity from ordinary completion-rate claims.

Add deterministic simulation scenarios with configurable thinking/action delays and mistake policies. Report comparisons for starter equipment, the two modules, and selected permanent upgrade levels. Keep oracle solvability, simulated pacing, and observed player behavior separate.

Retain existing aspirational targets unless measurements justify changing them: first breach under 90 seconds, completion at least 70%, skip rate approximately 10–20%, and at least two missions per session. These are playtest targets, not guarantees an automated test can prove.

**Acceptance:** Opening/resuming a run cannot inflate attempts or sessions incorrectly; repeated result views cannot duplicate observations. Provide a repeatable simulation command or test report with policy/seed details. Write a short manual playtest script for at least five players, but do not fabricate results or make human recruitment a blocker to software delivery.

## 5. Implementation order

| Phase | Scope | Exit condition |
| --- | --- | --- |
| 1. Reliability | F01–F05, F07–F08, critical portions of F03/F10 | First-session keyboard journey and save/resume regressions pass; normal campaign progression works |
| 2. Identity and state | F06, remaining F03, save migration, result/mode schema | Mission identity round-trips; old progress is preserved; retries/resume are deterministic |
| 3. Interface | E01, F09 | Lock/transfer status is readable; compact layout and keyboard navigation verified |
| 4. Mission depth | E02, E06, generator/validator portions of F10 | Chains, branches, all objectives, and modifiers have verified playable routes |
| 5. Progression and replay | E03–E05, E07 | Equipment choices, ending, records, daily attempt/resume, and corrected local stats work |
| 6. Delivery | F11–F12 and complete verification | Production build, test reports, updated docs, and implementation notes are ready |

F11's modularization and F12's documentation updates should also happen alongside the relevant changes. This order is a dependency guide, not permission to stop after phase 1.

## 6. Architecture and compatibility requirements

- Keep game rules, graph traversal, objectives, economy, equipment effects, record ordering, and challenge generation inside the engine or pure domain modules. React renders snapshots and submits intents/commands.
- Prefer focused modules for mission identity, persistence/migration, objective evaluation, and results. Avoid turning the main engine into an even larger command-and-feature collection.
- Use explicit mission node IDs/edges and typed objective/mode descriptors. A compatibility adapter can convert legacy chains into graphs.
- Version save data and mission generation independently. Accept existing `cybergrid.save.v1` data and migrate without resetting cash, XP, purchases, cleared contracts, or settings. Keep a recoverable legacy copy until migration succeeds.
- Legacy sessions lacking newly introduced optional fields need safe defaults. Derive tutorial position from restored progress when possible; never resume into contradictory tutorial gating. Missing historical trace details should be labeled unavailable rather than invented.
- Preserve version-1 mission generation for legacy active-session recovery and previously issued replay identities. Do not regenerate a legacy active job with new graph/objective rules. Unsupported or malformed data needs a recoverable message and explicit abandonment path.
- Persist run-start identity, selected loadout, elapsed active time, objective state, and daily eligibility atomically enough to avoid duplicate payouts or recorded attempts. Validate external share/save data before starting a mission.
- Treat background/closed-tab time explicitly: preserve the current paused-time approach, stop simulation while hidden, and communicate pause/resume. Records use engine active time. Human-readable daily dates derive from UTC.
- Do not add a backend, account system, external analytics, remote leaderboard, asset-generation dependency, or deployment requirement for this scope.

## 7. Verification plan

### Engine and persistence

- Add regressions for each reproduced defect before its fix where practical.
- Exercise successful, hot, early, and busted outcomes; empty-run rewards; no duplicate payment; completed campaign bounds.
- Serialize/resume the tutorial at every step and ordinary missions during every lock, partial knock input, transfer, watchdog/decoy period, and pending presentation action.
- Cover legacy save migration, malformed saves, pending-session preservation across multiple reloads, and purchased/equipped effects after resume.
- Round-trip mission identities across profiles, redraw paths, and versions. Verify daily determinism and attempt lifecycle with an injected clock.
- Test graph traversal and objective evaluation through the real `submit`/`tick` loop. A test that only inspects generated data does not prove the player can finish.
- Use a bounded, deterministic custom-seed corpus; include a deliberately failing candidate/fallback path. Do not rely on random flaky tests or an unbounded generation loop.

### Browser journeys

Use a focused browser runner, such as Playwright, if the project does not already have one. Research current primary documentation when adding or configuring dependencies.

Required journeys:

1. Boot, tutorial, first contract, results, board, next contract, and shop/loadout access through real keyboard submission.
2. Empty Enter retry versus a typed post-run command; TAB completion; history; paste; cleared input buffers.
3. Reload an active run, blur/change settings before resuming, reload again, and recover identical state.
4. Inspect a cipher clue, solve a lock, use panic tools during a lock, and verify timeout/skip/bust panels.
5. Complete each new objective, choose either branch, loot or leave the optional vault, and see consistent outcomes.
6. Equip a module, finish a job, inspect records, complete the campaign, and start/resume a daily attempt.
7. Check 390px/768px/1280px viewports, keyboard-only node inspection, focus return, 200% zoom, mute, and reduced motion.

Use stable accessible selectors/test IDs where appropriate. Do not expose an unrestricted production cheat API merely to make tests easy. Browser tests must exercise the actual keyboard handler at least once; invoking the bridge directly would miss F01 again.

### Required completion checks

Run `npm test`, `npm run typecheck`, `npm run build`, and the newly documented browser/simulation commands. Record exact commands, pass/fail results, relevant build warnings, and any remaining limitations. If browser binaries or another external dependency are unavailable, document the blocker and the unexecuted checks rather than claiming they passed.

## 8. Definition of done

- All required F01–F12 fixes and E01–E07 enhancements are implemented with their acceptance criteria met.
- The experience remains a text-heavy, immersive hacking game, with terminal interaction and enjoyable player decisions at the center of the UI/UX and gameplay.
- A documented browser playthrough, when the environment permits it, evaluates onboarding, mission pacing, puzzle feedback, tense escapes, failure/retry, and progression/replay. Address observed repetitive or confusing interactions and distinguish agent observations from human playtest findings.
- No fake buttons, placeholder objective types, hardcoded successful validations, or advertised but missing modes remain.
- Existing accounts are not required; existing local progress and valid legacy sessions have a documented recovery/migration path.
- Every generated mission that starts has passed the appropriate validation policy, or uses an explicitly verified safe template.
- First-session progression, equipment selection, new objective completion, campaign ending, daily attempts, records, and resume work together.
- Required automated checks pass, and any unexecuted environment-dependent checks are explicitly identified.
- README and implementation notes describe the application that actually ships, including mode/reward rules, share-code format, migration behavior, and test commands.
- The delivery report lists completed IDs, checks, tuning decisions, and genuine remaining limits. It does not claim human fun/retention targets were measured without a playtest.

## 9. Suggested first player study

After software verification, observe at least five players without coaching them through command choices. Record first successful command, first breach, first completed contract, confusion around clue discovery, use of escape tools, route choice, and willingness to start a second mission.

Ask what caused a failure and whether the player understood the risk before committing. Compare their explanation with trace breakdown and command history. Prioritize repeated confusion over isolated preferences; adjust one or two tuning variables at a time.

Also ask which moment was most enjoyable, which interaction became tedious, whether the text added immersion or interrupted the pace, and what would make the player want another run. Observe whether players discover different approaches and choose to replay voluntarily. Use this feedback to improve the entire play experience, including writing, UI/UX, functionality, mechanics, and progression.

## 10. Future backlog, outside the required implementation

These ideas may be useful after the required scope has been tested. They are not part of the companion prompt's implementation commitment:

- Additional puzzle families such as password rules, spatial routing, and multi-stage exploit chains.
- More graph archetypes, rival operators, dark runs, and reactive network defenses.
- Longer narrative arcs, factions, and persistent consequences across contracts.
- Full command editing conveniences such as reverse history search and configurable key bindings.
- Cross-device cloud saves, competitive ghost replays, and server-validated global leaderboards.
- Localization and a separately validated full screen-reader gameplay mode.

Choose these from observed player needs rather than adding them all at once.
