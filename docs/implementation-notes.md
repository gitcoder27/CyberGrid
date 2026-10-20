# CyberGrid — implementation notes (improvement plan delivery)

These notes record the decisions made while delivering
`cybergrid-review-and-improvement-plan.md`. They come after the PRDs
(`cybergrid-prd.md`, `cybergrid-prd-v2.md`), which stay as historical design
documents. Where the two disagree, this file and the README describe the
shipped game.

## Requirement map

| ID | What shipped | Where |
|---|---|---|
| F01 | The results screen is a mode (`post`) rather than an input trap. An empty Enter retries; any typed command runs normally. For 0.8 s after a result appears, a bare Enter is ignored, so keys still flying from a bust can't skip the after-action. | `game.ts` (`dispatchPost`, `cmdRetry`), `CommandLine.tsx` |
| F02 | A parked run is never replaced silently. Every way of starting a run goes through one gate that refuses while a run is parked (`resume` / `abandon`). Saves always write the parked session back. | `game.ts` (`beginRun`), `persistence.ts` |
| F03 | The resume snapshot covers everything the player can see: lock family/fuse/attempts, partial knock input, an interrupted knock glow (replays in full), cipher wheel known, transfer %, pending scan/breach actions, watchdog and decoy timers, tools, cwd, objective state, counters and loadout. A tutorial resumes at its step. The time the app was closed is never charged. | `game.ts` (`snapshotSession` / `restoreSession`) |
| F04 | Cipher wheel tags are placed on owned or current nodes. `cat` (plus `ls`/`cd`) work while a lock is open. Reading the tag puts the decoding strip in the lock panel. | `gen/v2.ts`, `game.ts` lock passthrough |
| F05 | Outcomes are `clean` / `hot` / `early` / `busted`. Clean requires the objective. An empty run earns no clean-exit XP. The thresholds are exact (49.95 vs 50 is tested). | `results.ts` |
| F06 | Mission descriptors plus checksummed share codes. Generation 1 is frozen for legacy recovery; seeds rebuild the job they display, including redraws. | `identity.ts`, `gen/` |
| F07 | The campaign clears only on the canonical contract 10. The ending plays once, `epilogue` replays it, and the suggestion then points at `daily`, not a contract 11. | `game.ts` |
| F08 | `proxy`, `decoy`, `hint`, `skip`, `disconnect` and file reads work during a lock. | `game.ts` |
| F09 | Breakpoints at 1180 px (map drawer) and 760 px (intel drawer, 16 px input). Keyboard focus management with Esc/Shift+Tab exits, a skip link, a screen-reader transcript, a status announcer, and gating for reduced motion and the `motion` setting. Composing a command from a drawer closes the drawer. | `App.tsx`, `Hud.tsx`, `styles.css`, `CommandLine.tsx` |
| F10 | 139 engine tests, 8 bridge tests, 19 Playwright journeys (plus the opt-in full campaign), and `npm run sim`. | `packages/engine/test`, `app/e2e`, `simulate.ts` |
| F11 | Extracted modules: identity, graph, objectives, equipment, results, persistence, validate, simulate, text, and gen. The WebGL addon is lazy-loaded; measurements below. | — |
| F12 | README rewritten for shipped behavior; these notes; a playtest script. | `README.md`, `docs/` |
| E01 | Docked lock panel: family, fuse bar, tries, sequence chips, glowing ports or memory dots, wheel strip, and buttons that compose escape hatches. Transfer panel: %, seconds left, trace rate, watchdog ×2. Trace meter shows phase, rate, source and the clean-exit line. Graph map with a node inspector. | `Hud.tsx` |
| E02 | Explicit node graphs. Fork/rejoin roads (long vs hot), an optional vault, and flagged / dossier / payload objectives. `upload` verb. | `gen/v2.ts`, `graph.ts`, `objectives.ts` |
| E03 | One module slot: burst and quiet uplinks, unlocked at Operator and Breacher. Permanent shop upgrades are kept. A run keeps the rig it started with. | `equipment.ts` |
| E04 | Campaign ending and epilogue. Bounded local records: a best per job + rig, recent runs, and daily attempts. | `results.ts`, `text.ts` |
| E05 | Daily challenge from the UTC date at tier 5 on a fixed stock rig. The first run is recorded; reloads and resumes keep it alive; later runs are practice. A code from another day replays as practice. | `identity.ts`, `game.ts` |
| E06 | NOISY LINK and ACTIVE PATROL, at most one per job, never on introductory contracts, each with a +$180 bonus. | `config.ts`, `game.ts` |
| E07 | `stats` corrected: tutorial excluded, outcomes by job type, objective and lock family. Plus the deterministic balance simulation below. | `game.ts`, `simulate.ts` |

## Save compatibility

- v1 → v2 migration runs on load and keeps cash, XP, purchases, cleared
  contracts and settings. The v1 key stays as a backup.
- A legacy parked run is converted onto its generation-1 network. A missing cwd
  is inferred from saved command history. Missing trace history is labelled
  "unrecorded" in the after-action instead of being invented.
- A corrupt save is copied aside before a fresh start.
- A run that can't be rebuilt becomes a `brokenSession`, with a message and an
  `abandon` path.
- Fixtures for these cases are in `packages/engine/test/fixtures/legacy-v1-saves.json`:
  - mid-transfer contract
  - tutorial download step
  - cipher lock with crowbar fuse
  - pre-shop profile

  The same fixtures drive the browser migration journey.

## Validation policy

Every generated job is played before it starts by an oracle that drives the
real engine, with think time (4 s per breach, 2.5 s per download, 1.5 s per
other action). Both fork roads must pass with the stock rig.

A job passes when:
- the objective is complete,
- trace never reaches 100,
- the final trace is ≤ 85,
- tiers ≤ 3 can exit clean.

Draw schedule:
- **Generation 2:** 24 redraws, then 10 relaxed redraws, then a verified safe
  template; otherwise the job is refused with a message.
- **Generation 1:** keeps its original schedule so legacy seeds rebuild
  byte-for-byte.

## Tuning decisions

The documented defaults were kept unless the simulation contradicted them; it
didn't:

- burst 0.8× duration at 1.5× trace rate
- quiet 1.25× duration at 0.6× trace rate
- modifiers +50% transfer trace or a double-speed watchdog from the start,
  each +$180
- custom jobs pay a 0.5× contract bonus
- the daily runs at tier 5

`npm run sim` covers 22 missions: campaign 1–10, nine custom seeds at tiers
2/5/8, and three dailies.

| Policy | Done | Clean | Busted | Notes |
|---|---|---|---|---|
| oracle (perfect) | 22/22 | 20 | 0 | avg end trace 37, ~24 s simulated |
| cautious (2.5× think time) | 22/22 | 21 | 0 | avg end trace 41 |
| one mistake (1.5× think) | 22/22 | 14 | 0 | avg end trace 49 |
| sloppy (3 wrong answers, 2× think) | 21/22 | 2 | 1 | avg end trace 65 |
| human-paced (6× think time, 1 mistake) | 19/22 | 7 | 3 | avg end trace 66, ~142 s |
| greedy (vault + loot) | 21/22 | 13 | 1 | avg cash $1225 vs $834 perfect |
| no tools | 21/22 | 8 | 1 | no proxy/decoy, no log wipes |

Loadouts under the greedy policy:

| Loadout | Done | Busted | Avg transfer time |
|---|---|---|---|
| stock | 21/22 | 1 | 6.8 s |
| burst | 20/22 | 2 | 5.3 s (faster, louder) |
| quiet | 22/22 | 0 | 8.5 s (slower, safer) |
| maxed | 22/22 | 0 | – |

Fork roads, over 13 forked jobs:

| Road | Avg end trace | Avg time |
|---|---|---|
| long | 37.7 | 39 s |
| hot | 41.2 | 30.7 s |

Neither road dominates, which is the intent. The modules are a real trade, not
an upgrade ladder.

These are simulated policies. They are not human results.

## Performance (F11)

Production build, Vite 5 / Rollup, before and after:

| | raw | gzip |
|---|---|---|
| Before (one chunk incl. WebGL addon) | 644.36 kB | 182.17 kB |
| After: initial JS | 634.65 kB | 185.28 kB |
| After: WebGL addon (lazy, loaded on idle when WebGL2 exists) | 110.20 kB | 30.14 kB |
| After: CSS | 19.19 kB | 5.78 kB |

The initial payload holds the generation-2 engine, records, daily, the new HUD
and the native command line. It is about 3 kB larger gzipped than the old
bundle. Without the split it would be roughly 215 kB gzipped, so deferring
WebGL keeps the feature growth almost free on first load. The terminal renders
with xterm's DOM renderer until the addon arrives.

Initial chunk composition:
- xterm ≈ 288 kB
- engine ≈ 164 kB (≈ 55 kB gzip)
- react-dom ≈ 130 kB

The chunk-size warning remains. It is an optimization signal, not a failure.
Splitting further would mean deferring xterm or the engine, and both are
needed for the first frame.

Snapshot cost (`npx vite-node packages/engine/scripts/profile-snapshot.ts`,
contract 10 mid-run):

| Call | Cost |
|---|---|
| `getState()` | ≈ 46 µs |
| `tick(1/60)` | ≈ 0.4 µs |
| `serialize()` | ≈ 1 µs |

The HUD refreshes on state events and every 150 ms during a run, so snapshot
work stays well under 1% of a frame. No further optimization was justified.

## Agent browser playthrough (observations, not player research)

All of this was done by the coding agent with Playwright-driven Chromium,
using the same scripted keyboard "player" as the e2e suite plus screenshots.
No human playtest was run. The `docs/playtest-script.md` protocol is for that.

Full campaign from the keyboard: ten contracts, all first try. The naive player
follows every suggestion and never wipes extra logs. Real time was 14–20 s per
contract (the script plays much faster than a person). Results:

| Contracts | Outcome | Trace |
|---|---|---|
| 1, 2, 4 | clean exit | 41–49% |
| 3, 5, 7–10 | hot exit | 51–76% |
| 6 (noisy link) | hot exit | 92% |

Contract 6 was the tensest moment: a 75% admin alert mid-download, with the
watchdog doubling the transfer.

Friction found and fixed during the pass:

1. **Coach silent past the junction.** After the roads rejoined, the coach went
   quiet because the abandoned road still had an unbreached node, which nudged
   the player into a pointless hard breach. The coach now counts a neighbor as
   a choice only if it leads to the objective without coming back
   (regression test added).
2. **Duplicate scan.** The previous suggestion stayed visible while a scan was
   spinning up, so TAB+Enter ran it twice ("something is already running").
   Suggestions now hide while an action is pending.
3. **Enter during a bust.** A player hammering Enter through the bust sequence
   retried before seeing the after-action. A short guard was added.
4. **Knock glow after resume.** Resuming during the glow left a fraction of a
   second to memorize it. An interrupted glow now replays in full.
5. **Loot paths.** Breaching a loot node listed only a count, which forced an
   `ls`/`cd` hunt. The paths are now listed.
6. **Sequence lock display.** The dock repeated the full sentence. It now shows
   the terms as chips with a dashed `??`.
7. **Scan column overlap.** Columns overlapped for 14-character IPs
   (`10.188.190.119CINDERBLOCK`). They are now sized to content.
8. **Stale Broker panel.** The panel kept tutorial step chatter after the
   tutorial and stayed empty on results. A finished run now clears it. The
   tutorial ends with a sign-off, and post-run debriefs show in the panel.
9. **Tutorial ordering.** OBJECTIVE MET printed after the next instruction, and
   the tutorial banner showed a meaningless seed. Both fixed.
10. **Drawer after composing.** On phones, composing a command from the map
    drawer left the drawer covering the input. The drawer now closes.
11. **IME Enter.** An Enter during IME composition could fall through to the
    form's implicit submit. It is now prevented.

Assessment (agent judgment, to be checked with players):

- **Onboarding:** short (≈ 11 s of active play), and the TAB glow makes the
  verbs learnable.
- **Pacing:** contracts sit at 20–40 s simulated for a perfect player and
  ≈ 2.5 min human-paced.
- **Retry:** busts are one keypress away.
- **Replay hooks:** the daily, share codes, records and road choice give
  reasons to replay.

The main open questions are for humans:
- whether the hot exits feel like failures or like tension,
- whether the knock memory challenge is too easy, given the terminal shows the
  sequence in scrollback (an accepted MVP decision),
- whether contract 6 is a spike.

## Not verified

- **Human players:** no playtest was run.
- **Screen readers:** no NVDA / JAWS / VoiceOver pass. The transcript and
  announcer were only checked through the DOM.
- **Browsers:** Firefox and Safari were not run; only Chromium.
- **Mobile devices:** layouts were checked with viewport emulation
  (390 / 640 / 768 / 1280 px). No real touch device was used.
- **Audio:** not perceptually checked.
