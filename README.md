# CyberGrid

**A tension game disguised as a terminal.** You are a freelance operator taking
contracts from *the Broker* over a burner terminal. Scan a network, breach its
nodes by beating their locks, steal the flagged files — and get out before the
**trace meter** hits 100%. Every second on a foreign network burns you; every
log you wipe buys margin; every download is loud.

Week-1 MVP per `docs/cybergrid-prd-v2.md` (§6, §18) — 100% client-side.

---

## Run it

```bash
npm install
npm run dev        # → http://localhost:5173
```

That's the whole install. No backend, no database, no API keys. `npm run build`
produces a static bundle in `app/dist` deployable to any static host; `npm test`
runs the full headless test suite (engine + UI bridge).

## How to play (90-second version)

1. **Boot** — press any key to skip the BIOS chatter.
2. **Tutorial** — the handler suggests it on first run (`tutorial`). The next
   command always glows (bottom-right chip); **TAB fills it in**. One lock is
   pre-disarmed: whatever you type first succeeds. `skipintro` leaves anytime.
3. **Contract** — `contracts` lists the board, `run 1` accepts. Then:
   - `scan` — map the chain: security, loot, flagged files.
   - `breach <ip>` — attack an adjacent node; a lock opens on your terminal:
     - *packet interval lock*: `input 16`
     - *knock sequence*: ports glow, then go dark — `knock 22 443 8080`
       (you may also knock one port at a time)
     - *cipher plaque*: decode the Caesar-shifted word — `input WORD`
       (`cat plaque.txt` on the node leaks the wheel offset)
   - `cd /srv` · `ls` · `download <file>` — flagged files pay; transfers run
     +5 trace/s.
   - `rm /var/log/auth.log` — every wiped log is **−8 trace**.
   - `disconnect` — below 50% trace: **CLEAN EXIT**, payout ×1.5. Above: you
     keep the loot, the Broker smiles less. At 100%: busted — loot gone, XP
     halved, `[ENTER]` retries the same seed instantly.
   - Panic buttons: `proxy hop` (−25 trace, once) and `decoy` (blinds the
     watchdog ~25s, once). `skip` forces any lock open (+25 trace), `hint`
     buys a clue (cash). **You are never hard-stuck.**

### Command list

| Home | Mission |
|---|---|
| `help` `man <cmd>` | `scan` `connect <ip>` `breach <ip>` |
| `contracts` | `ls` `cd <dir>` `cat <file>` |
| `run <n>` / `run seed <SEED>` | `download <file>` (aliases `dl` `scp` `get`) |
| `tutorial` | `rm <path>` `disconnect` (aliases `exit` `quit` `escape`) |
| `profile` `settings` | `input <x>` `knock <ports…>` `skip` `hint` |
| `shop` · `buy <id>` · `stats` | `proxy` `decoy` |
| `resume` `abandon` `wipe confirm` | `help` `man <cmd>` `profile` `clear` |

Case-insensitive, aliases everywhere, typos get "did you mean", TAB completes
verbs / paths / IPs, ↑↓ is history.

---

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│  app/  (React + Vite — a view layer, nothing more)         │
│                                                            │
│  TerminalView ── xterm.js (WebGL), typewriter writer,      │
│                  TAB/history/forgiving input               │
│  Hud         ── trace meter, node map, objectives, tools,  │
│                 handler chat (reads snapshots only)        │
│  Synth       ── Web Audio, 100% synthesized (no assets)    │
│  Bridge      ── the seam: submit(cmd) → events; tick(dt);  │
│                 routes events to queues the UI drains      │
└────────────────────────┬───────────────────────────────────┘
                         │ submit(line) / tick(dt) / getState() / serialize()
┌────────────────────────▼───────────────────────────────────┐
│  packages/engine  (@cybergrid/engine — no DOM, no deps)    │
│                                                            │
│  game.ts      state machine: home/mission/post, trace &    │
│               escalation, watchdog, tools, scoring, save   │
│  missions.ts  seeded generator (linear chain, PRD §15)     │
│  validate.ts  solvability gate: simulates a perfect run    │
│               through the real engine before a mission ships│
│  puzzles.ts   sequence · port-knock · cipher (PRD §8)      │
│  commands.ts  verb table, diegetic man pages, "did you     │
│               mean" (Levenshtein)                          │
│  tutorial.ts  scripted mission 0 (PRD §11)                 │
│  vfs.ts       per-node virtual file system                 │
│  config.ts    EVERY tunable number lives here              │
│  rng.ts       xmur3+mulberry32, serializable state         │
└────────────────────────────────────────────────────────────┘
```

**The whole game loop is testable headless**: the engine exposes
`submit(commandString) → events` and `tick(dtSeconds) → events`; React only
renders snapshots and drains event queues. Tests drive the same API the UI
does — including mission solvability, which is validated by *playing* a perfect
run through the real engine (`validate.ts`).

Determinism: all randomness flows from the mission seed (same seed → byte-identical
mission spec). Fixed contract seeds (`CG-OMEN-01`…`CG-OMEN-10`) are identical for
every player; `run seed <anything>` accepts custom shares.

Persistence: localStorage (`cybergrid.save.v1`) — cash/XP/rank/contracts +
settings autosave after every mission, on tab blur, and every 5s mid-run.
A mid-run snapshot offers `resume` / `abandon` on return (PRD §4.3).

## Trace system (the game)

| Action | Trace |
|---|---|
| idle on a foreign network | +0.15/s (×2 under admin alert) |
| `connect` hop | +2 |
| `breach` (by security 1/2/3) | +8 / +11 / +15 |
| wrong answer or expired fuse | +15 |
| downloading | +5/s while transferring |
| `rm` a log | **−8** |
| `skip` a lock | +25 |
| `proxy hop` | −25 (one per job) |

Escalations: **50%** a watchdog daemon spawns and patrols — breaching its node
costs **double** (a `decoy` blinds it). **75%** admin alert: creep doubles, the
room turns red, alarm pitch climbs. **100%** busted: cutscene, loot lost, XP
halved, one-keypress retry. Under 50% at `disconnect`: clean exit, payout ×1.5.

## The Broker's market & the tuning loop

**`shop` / `buy <id>`** — cash is no longer just a score. Six permanent upgrades
(PRD §10's list, lite edition) apply to every future job:

| id | effect | max |
|---|---|---|
| `relay` | +1 proxy hop per job | 2 |
| `drone` | +1 decoy per job | 1 |
| `overclock` | transfers 15% faster per level (and trace-lighter) | 3 |
| `ghosting` | idle trace creep −20% per level | 2 |
| `crowbar` | lock fuses +8s per level | 2 |
| `insider` | hints cost 40% less | 1 |

Prices escalate ×1.6 per level (catalog in `CONFIG.shop`) — a ~$4,000 sink that
paces the campaign at roughly 10–20 missions. No refunds, obviously.

**`stats`** — the PRD §17 tuning loop made legible. The engine observes play
(pure counters in the save blob: runs by outcome, locks cracked vs skipped,
time to first breach, hints/proxies/decoys burned, final trace, sessions via a
30-min activity gap) and `stats` scores your actual numbers against the targets:

```
───[ WIRE ANALYTICS — self-report ]────────────────
  runs       12 started · 9 completed · 2 busted · 1 short
  completion 75% (target ≥70%)
      ✓ on target
  first hit  ~41s to first breach (target <90s)
  locks      34 met · 26 cracked · 5 skipped (16%) · 9 failures
      ✓ sweet spot (10–20%)
  rhythm     ~2.3 runs/session over 4 sessions (target ≥2)
```

Tutorial runs are excluded so they never pollute the signal, and telemetry is
observation-only — it never touches game outcomes or the mission RNG.

## Decisions made (where the PRD was silent or self-contradictory)

1. **Idle creep retuned to +0.15/s** (PRD §7 says +1/s). At +1/s a 3-minute run
   accrues 180 trace — every mission would bust, making §16 (3–8 min runs,
   ≥70% completion) and §7's clean-exit bonus mathematically impossible. All
   *per-action* costs ship exactly as §7 specifies. The knob is
   `CONFIG.trace.idlePerSecond`.
2. **Breach ⇒ connected.** `breach` drops you onto the node it opens;
   `connect` exists for hopping back to nodes you already own (retreating for
   files you passed) at +2 trace. Otherwise the two verbs blur together.
3. **Connect reaches any owned node**, not just chain neighbors — you tunnel
   through your own breaches. `breach` stays strictly adjacent, which preserves
   the linear-chain route-planning game.
4. **Puzzle answer verbs** (`input` / `knock`) live inside the breach flow
   rather than the 8-verb count; bare answers (`16`, `GHOST`) also work. The
   PRD's verb table doesn't cover puzzle input; v1's example used `input`.
5. **Tools ship pre-equipped.** The upgrade shop is Phase 2, so every job loads
   1 proxy hop + 1 decoy. §7's `sleep <node>` is cut (needs hiding mechanics
   that only pay off with the shop's tool economy).
6. **Payouts** follow §7's multiplier reading: per-file cash ×1.5 on clean
   exit, + flat contract bonus, + $25/log. Busted keeps 50% XP, $0 cash — and
   an *incomplete* extraction (disconnecting with fewer than the required
   files) pays loot but no contract bonus, with its own copy ("EXTRACTED
   EARLY") so it never reads as success.
7. **Port-knock memory** displays the sequence as glowing text, then goes dark
   after ~4.5s. Players *can* scroll back to peek — accepted for MVP: it costs
   idle trace, and terminal scrollback is the fiction anyway.
8. **De-escalation is possible**: dropping below 75 clears the alert; below 50
   the watchdog despawns. The PRD only describes escalation; silence on the way
   down would make proxy hops feel rigged.
9. **Difficulty modes** (§16 Casual/Standard/Hard) are cut from the MVP; every
   knob they'd turn already lives in `config.ts`.
10. **Contract 1 sends the tutorial's rules live**: lock families are gated so
    cipher plaques debut on contract 4+ (§8 "Week 1"), knock sequences from
    mission 1 (§8 "Mission 1").
11. **Shop-lite and telemetry were pulled forward** from the Phase-2/§17 plans
    after first play sessions: the shop ships a bounded catalog (no verbs are
    purchasable yet — that stays Phase 2), and telemetry is local-only counters
    in the save blob (no analytics leave the browser).

## What was cut (per scope discipline)

Backend/server/leaderboards, upgrade shop, narrative campaign (the Broker's
2-line handler chats carry the tone), daily challenges, ghost races, mobile
input mode — all Phase 2+. Also cut from §7–§16: `sleep`, connection maze /
password audit / priv-esc puzzles (Phase 2/3 families), topology archetypes
beyond the linear chain, mission modifiers (ICE, dark runs, decoy files, rival
ghost), difficulty modes. Nothing in-scope is stubbed; everything listed as
shipped is implemented and tested.

## Tests

```bash
npm test          # engine (61) + bridge (4), all headless
```

Coverage highlights: every fixed contract and the tutorial are validated
solvable (perfect-run simulation through the real engine, with margin ≤ 85
trace, clean exit achievable through contract 3); same-seed → identical
mission; trace math per §7 (breach table, +15 mistakes, −8 logs, +5/s
transfers, 2× alert creep); escalation at 50/75/100 including watchdog doubling
and the busted payout path; all three puzzle families (generation, grading,
hints, skip, fuse timeout, forced tutorial success); resume-from-serialize;
autocomplete and forgiving parsing; rank thresholds.

## Repo map

```
packages/engine/     @cybergrid/engine — deterministic game core (TypeScript, zero deps)
  src/config.ts      every tunable number
  src/game.ts        GameEngine: submit/tick/getState/serialize
  src/validate.ts    perfect-run solvability gate
  test/              61 headless tests incl. full playthrough transcript
app/                 React 18 + Vite 5 + @xterm/xterm (WebGL) client
  src/terminal/      xterm wiring, typewriter writer
  src/hud/           trace meter, node map, objectives, handler chat
  src/audio/         synthesized SFX + trace-tracked alarm
  src/bridge.test.ts headless tests for the UI's event routing
docs/                PRD v2 (design source of truth) + v1
```
