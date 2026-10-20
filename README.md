# CyberGrid

**A tension game disguised as a terminal.** You are a freelance operator taking
contracts from *the Broker* over a burner terminal. Scan a network, breach its
nodes by beating their locks, take what the job asks for — and get out before
the **trace meter** hits 100%. Every second on a foreign network burns you;
every log you wipe buys margin; every transfer is loud.

100% client-side: no backend, no accounts, no analytics. Progress lives in this
browser's `localStorage`.

> Design history: `docs/cybergrid-prd.md` (v1) and `docs/cybergrid-prd-v2.md`
> are the original design documents and are kept as historical records.
> `docs/cybergrid-review-and-improvement-plan.md` and
> `docs/implementation-notes.md` describe the later decisions this build ships.

---

## Run it

```bash
npm install
npm run dev        # → http://localhost:5173
```

`npm run build` type-checks and writes a static bundle to `app/dist` (any static
host works; nothing is deployed by this repo).

## How to play (90-second version)

1. **Boot** — any key skips the BIOS chatter. A typed command still runs.
2. **Tutorial** — `tutorial`. The next command glows in the input line;
   **TAB fills it**, Enter runs it. One pre-disarmed lock teaches the idea.
3. **Contract** — `contracts` shows the board, `run 1` jacks in. Then:
   - `scan` — map the network (left panel): security, lock type, loot, logs,
     links, objective markers.
   - `breach <ip>` — attack a node next to one you own. A lock docks above the
     input line with its fuse:
     - *packet interval lock*: four numbers, one rule → `input 16`
     - *knock sequence*: ports glow, then go dark → `knock 22 443 8080`
     - *cipher plaque*: Caesar-shifted word. The wheel tag (a file somewhere on
       the network, often the node you stand on) prints the decoding strip into
       the lock panel. `cat` works **while the lock is open**.
   - `download <file>` / `upload <payload> <dir>` — transfers burn trace while
     they run; the dock shows progress, seconds left and the trace rate.
   - `rm /var/log/auth.log` — every wiped log is **−8 trace**.
   - `disconnect` — under 50% trace with the objective done: **CLEAN EXIT**
     (payout ×1.5). Over 50%: **HOT EXIT**. Objective unfinished: **EXTRACTED
     EARLY** (loot only, no contract bonus). At 100%: **BUSTED** — loot lost,
     XP halved, and an empty **Enter** on the results screen retries the same
     job.
   - Panic buttons work mid-lock: `proxy` (−25 trace), `decoy` (sends the
     watchdog to the far end of the network), `skip` (forces a lock, +25),
     `hint` (cash). **You are never hard-stuck.**

### What a job can be

| | |
|---|---|
| **Topology** | *chain* (one road) or *fork*: a long road of softer locks vs a hot road with one hard lock, rejoining at a junction. The coach never picks your road. |
| **Vault** | optional side room on forked jobs — extra loot, extra trace. Breaching it names the loot paths. |
| **Objective** | *flagged files* (steal N), *dossier* (one specific file on a deep node), *payload* (upload your implant to a drop directory). |
| **Modifier** | *NOISY LINK* (transfers +50% trace, +$180) or *ACTIVE PATROL* (watchdog from the start, moving twice as fast, +$180). |

The ten contracts introduce these in order: chains (1–3), first fork (4),
dossier (5), noisy link (6), payload (7), patrol (8), then combinations (9–10).
Finishing contract 10 closes the campaign; `epilogue` is the Broker's last
message, and every contract stays replayable.

### Progression

- **Ranks** (XP): Script Kiddie → Operator (300) → Breacher (800) → Ghost (1600)
  → Elite Operator (3000). Ranks unlock **modules** for the single equipment
  slot — free, swapped with `equip` at home, sealed during a job:
  - `burst` uplink (Operator): transfers 20% faster, ~20% more total trace.
  - `quiet` uplink (Breacher): transfers 25% slower, ~25% less total trace.
- **Shop** (`shop`, `buy <id>`): permanent upgrades — `relay` (+1 proxy),
  `drone` (+1 decoy), `overclock` (faster transfers), `ghosting` (less idle
  creep), `crowbar` (longer fuses), `insider` (cheaper hints).
- **Records** (`records`): best result per job and rig (completed > clean >
  payout > lower trace > faster), daily attempts, recent runs. Local only.
- **Daily challenge** (`daily`, `daily start`): one job per UTC date, the same
  for everyone, on a fixed stock rig. The first run of the day is the recorded
  attempt (reloads and `resume` keep it alive); later runs are practice.
- **Custom and shared jobs**: `run seed <anything> [--tier 1-10]`, `share`
  prints a code, `run <CODE>` rebuilds that exact job on any terminal.
  Custom jobs pay half the contract bonus and never advance the campaign.
- **Stats** (`stats`): local self-report — completion, outcomes by job type,
  objective and lock family, lock skip rate, rhythm.

### Commands

| Home / results | Mission |
|---|---|
| `help` `man <cmd>` | `scan` `connect <ip>` `breach <ip>` |
| `contracts` `run <n>` `run seed <S>` `run <CODE>` | `ls` `cd <dir>` `cat <file>` |
| `tutorial` `daily` `daily start` | `download <file>` `upload <payload> <dir>` |
| `retry` (empty Enter on results) `home` | `rm <path>` `disconnect` |
| `shop` `buy <id>` `loadout` `equip <m>` | `input <x>` `knock <ports…>` `skip` `hint` |
| `records` `stats` `profile` `share` | `proxy` `decoy` `share` `clear` |
| `settings` `resume` `abandon` `epilogue` `wipe confirm` | `help` `man <cmd>` `profile` |

Case-insensitive, aliases everywhere (`dl`, `exit`, `ssh`…), typos get "did you
mean". The input line: **TAB** fills the glowing suggestion, then completes
verbs, paths and IPs; **↑/↓** history; **Ctrl+C** clears; **Esc** clears, and
**Shift+Tab** (or Esc then Tab) leaves the field. Map nodes and HUD buttons
only *compose* commands into the input line — Enter still runs them.

`settings`: `volume`, `mute`, `crt`, `motion` (shake/glitch/flash; also off
under the OS "reduce motion" preference), `typing` (typewriter text), `assist`
(next-move suggestions).

### Accessibility and layout

- A screen-reader log mirrors terminal output; lock, outcome and fuse events
  are announced in a polite status region. The xterm canvas is decorative.
- Everything is reachable by keyboard; a skip link jumps to the command line.
- Below 1180 px the map becomes a drawer; below 760 px intel does too, the
  input font grows to 16 px (no mobile zoom-on-focus), and the urgent strip
  (trace, objective, tools, lock, transfer) stays docked above the input.
- A hidden tab pauses the mission clock and says so when you return.

---

## Saves and compatibility

- Current save: `cybergrid.save.v2` (schema v2: profile, settings, history,
  parked run, records, daily attempts).
- An existing `cybergrid.save.v1` is migrated on first load — cash, XP,
  purchases, cleared contracts and settings are kept, and a parked legacy run
  resumes on the **same** generation-1 network (open lock, fuse, transfer and
  all). The v1 key is left in place as a backup.
- An unreadable save is copied to `cybergrid.save.corrupt` before a fresh
  profile starts. A parked run that can't be rebuilt is reported with an
  `abandon` path instead of crashing.
- Autosave: every 5 s during a run, on blur, on tab hide and on page close.

## Mission identity

Every job has a descriptor (generation, mode, seed, tier, topology, objective,
modifier) and a share code: `CG1-<gen><mode><tier><topology><objective><modifier>-<base32 seed>-<checksum>`.
Generation 1 (the original linear chains) is frozen so legacy runs and old
seeds rebuild byte-for-byte; generation 2 adds graphs, objectives and
modifiers. Before any generated job starts, an oracle plays it through the real
engine (both fork roads, with think time) and it must finish without busting
(peak < 100, final ≤ 85, clean exit possible on early tiers). Failed draws are
redrawn deterministically, then relaxed, then a verified safe template is used.

## Architecture

```
app/  (React 18 + Vite 5 — presentation only)
  terminal/   xterm output (WebGL addon lazy-loaded), typewriter writer,
              native <input> command line (TAB, history, IME-safe)
  hud/        trace meter, graph map, node inspector, lock/transfer/result dock,
              objective, tools, the Broker's panel
  engine/     Bridge: submit(line) → events; frame(dt); transcript; announcer
  persistence localStorage adapter (v2 + v1 backup + corrupt copy)
  audio/      synthesized Web Audio (no assets)

packages/engine  (@cybergrid/engine — no DOM, no runtime deps)
  game.ts         state machine (boot/home/mission/post), commands, trace,
                  watchdog, tools, transfers, coach, save/restore
  identity.ts     descriptors, share codes, daily seeds
  gen/            generation 1 (frozen chains) and generation 2 (graphs)
  graph.ts        neighbors, paths, frontier
  objectives.ts   flagged / dossier / payload evaluation
  equipment.ts    modules, upgrades, effective rig numbers
  results.ts      outcomes, scoring, records ordering
  persistence.ts  save schema, v1 → v2 migration, legacy session conversion
  validate.ts     oracle playthrough + validated build schedule
  simulate.ts     deterministic balance scenarios (policies × loadouts × routes)
  puzzles.ts · commands.ts · tutorial.ts · vfs.ts · text.ts
  config.ts       every tunable number
```

Game rules live in the engine; React renders snapshots and submits command
strings exactly as typed.

## Tests and checks

```bash
npm test               # engine (vitest, 139 tests) + app bridge (8 tests)
npm run typecheck      # engine, app, and browser tests
npm run build          # production bundle
npm run sim            # deterministic balance report; fails if the oracle can't finish a job
npm run test:e2e       # Playwright browser journeys against the production build
CG_CAMPAIGN=1 npm run test:e2e -- e2e/campaign.e2e.ts   # opt-in: all ten contracts from the keyboard (~5 min)
```

First-time browser setup: `npx playwright install chromium`.

The browser journeys type on the real keyboard and solve locks by reading the
lock panel and the screen-reader transcript — no engine back doors. They cover
the first session (tutorial → contract → results → board), empty-Enter retry,
TAB/history/paste, save → reload ×2 → resume with an open lock, v1 migration
mid-transfer, cipher clue + panic tools mid-lock, fuse burn / skip / bust /
retry, each objective type on either road plus the vault, equip → final
contract → epilogue → records, daily recorded vs practice (with a fake clock)
and daily resume, layouts at 390/640/768/1280 px, keyboard map inspection,
mute, reduced motion and IME composition.

## Scope

Shipped: everything above. Not shipped (future ideas from the improvement
plan's backlog): online leaderboards or ghost races, accounts or cloud saves,
new lock families (connection maze, password audit, privilege escalation),
`sleep`, additional modifiers (ICE, dark runs, decoy files, rivals),
difficulty presets.

## Repo map

```
packages/engine/     deterministic game core (TypeScript)
  scripts/sim.ts     `npm run sim`
  test/              unit, regression, migration, identity, mode and playthrough tests
  test/fixtures/     legacy v1 saves and frozen generation-1 fingerprints
app/                 React client
  e2e/               Playwright journeys (player.ts = the keyboard "player")
docs/                PRDs (historical), improvement plan, implementation notes, playtest script
```
