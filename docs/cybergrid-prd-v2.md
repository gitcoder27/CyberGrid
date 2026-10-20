# Product Requirements Document: Project "CyberGrid" — v2 (Enhanced)

> **Version:** 2.0 · **Date:** 2026-09-05 · **Status:** Draft for review
> **v2 changelog:** Adds design pillars, narrative frame, trace/tension system, puzzle families, mission grammar, progression meta, onboarding, failure design, juice & audio spec, command grammar, HUD spec, revised client-first architecture, fun metrics, phased roadmap, and risk register. Original sections 1–6 preserved and expanded.

---

## 1. Executive Summary

Project "CyberGrid" is a fast-paced, highly engaging terminal-based hacking game. Designed to make the player feel like an elite operator, it balances authentic command-line interfaces with user-friendly, accessible gameplay. Players will use critical thinking to breach virtual nodes, but the difficulty is tuned to ensure a flow state rather than frustration, making it highly enjoyable for both developers and casual puzzle fans.

**v2 positioning:** CyberGrid is a *tension game disguised as a terminal*, not a terminal simulator. The trace timer, the decisions it forces, and the escape are the product. Everything else — the CLI, the puzzles, the HUD — exists to serve that tension.

## 2. Product Vision & Goals

- **Enjoyable & Fun:** Focus on the "Hollywood hacker" feeling—fast typing, immediate visual feedback, and thrilling escapes.

- **Accessible Brain Teasers:** Logic puzzles that require thinking but rely on recognizable patterns (e.g., sequence matching) rather than deep programming knowledge.

- **User-Friendly:** Features like Tab-autocomplete, a built-in "help" manual, and a graphical HUD alongside the terminal to reduce the cognitive load.

- **Convenient:** Fully web-based. Zero installation required, playable instantly in any browser.

### 2.1 Design Pillars (new)

Every feature must serve at least one pillar. If it serves none, cut it.

1. **Fantasy first.** The player must feel like an elite operator within 10 seconds of loading — boot sequence, glow, first successful command inside the first minute.
2. **Every command is a decision.** The player should never just "type what they're told." Where to go, what to loot, when to run: the terminal is the instrument, the decision is the game.
3. **Tension you can see.** Risk must be legible. The trace meter, its rate of change, and escalation events are always on screen. No hidden death timers.
4. **Eight verbs, a hundred situations.** Depth comes from combining a small command set across varied networks and puzzles — not from teaching 50 commands.
5. **Never hard-stuck.** Every puzzle has a skip, every dead end has a way out. Frustration is spent on risk, never on confusion.

## 3. Core Gameplay Mechanics

### 3.1 The Three-Phase Loop (expanded to four beats)

| Phase | Player Action | Pacing & Difficulty |
|---|---|---|
| **1. Recon (Scan)** | Use simple automated commands to reveal connected nodes and their vulnerabilities. | Fast. Visual feedback instantly shows targets on a graphical map. |
| **2. Infiltration (Breach)** | Deploy scripts and solve quick logic puzzles to bypass firewalls. | Medium. Requires focus, but time-boxed to keep momentum high. |
| **3. Exfiltration (Extract)** | Navigate the virtual file system, grab data, and clear logs before the automated trace timer catches them. | Fast-paced and adrenaline-pumping. |
| **4. Escape (new)** | Disconnect before trace hits 100% — or use proxy hops, decoys, and route knowledge to buy time when it goes wrong. | Skill ceiling. Clean escapes score bonuses; panic escapes cost loot. |

**v2 addition — the decision layer.** After Recon, the network map shows each node's **security level** (puzzle tier), **loot value**, and **connection cost** (trace added per breach). The player has limited scripts and one mission window. Deeper nodes pay more and burn more trace. This turns every run into a route-planning problem: *grab three easy files and leave clean, or push for the vault and risk a hot exit?* Fun lives in this choice, not in the typing.

### 3.2 Command Line Interface (CLI) Features

To ensure the game remains convenient and easy to use, the terminal will include modern quality-of-life features:

- **Auto-Complete:** Hitting TAB completes commands and file names automatically.

- **Syntax Highlighting:** Commands, errors, and success messages are color-coded for fast reading.

- **Command History:** Up/Down arrows cycle through previous commands, so players don't have to retype complex strings.

**v2 additions:**

- **Small orthogonal verb set (see §9):** players master ~8 commands in the first hour; later tools *unlock new verbs*, so progression is felt at the prompt itself.
- **Diegetic help:** `help` lists verbs in one screen; `man <cmd>` opens a themed manual page written as a leaked internal doc. No external wiki required.
- **Aliases & forgiving parsing:** `dl`/`scp`/`download` all work; case-insensitive; trailing typos trigger a "did you mean" suggestion instead of a bare error.
- **Puzzle skip & hint are commands:** `skip` (costs +25 trace), `hint` (costs in-game cash). Being stuck is always the player's *choice*, never a wall.

## 4. Technical Architecture

### 4.1 Frontend Stack (as originally specced)

- **Terminal Emulator:** Xterm.js for robust, lightning-fast text rendering.
- **Framework:** React.js for managing state, HUD overlays, and out-of-terminal UI elements (like active trace timers).
- **Styling:** CSS with inline SVG animations to create a sleek cyberpunk aesthetic.

### 4.2 Backend Stack (revised — see §13 for rationale)

- **MVP (week 1): pure client-side.** The entire game sim runs in a deterministic TypeScript engine package in the browser. Progression persists in `localStorage`. Deploy as a static site (Vercel/Cloudflare Pages). **No server, no database, no WebSockets in week 1** — nothing in the MVP loop needs one, and removing the backend removes the riskiest, least fun-to-build component from the critical path.
- **Phase 2:** Node.js (Fastify) + Socket.io service for daily challenges, ghost races, and server-validated leaderboards. **PostgreSQL** for leaderboards/seasons. Seeds are authoritative: same daily seed for everyone, client submits a score plus a replay of seeded inputs for validation.

### 4.3 Core Technical Principles (new)

- **Deterministic seeded engine:** all randomness flows from a mission seed (e.g., `7F3K-09XA`). Enables shareable missions, daily challenges, replays, and later anti-cheat — and makes bugs reproducible.
- **Engine/UI separation:** game logic lives in a framework-agnostic package (`@cybergrid/engine`) with no DOM dependencies; React is a view layer. Enables headless testing of the entire game loop.
- **Performance budget:** WebGL-backed xterm renderer, HUD animations on CSS transforms only, 60 fps target on a 5-year-old laptop, <2s cold load.
- **Save system:** autosave after every mission and on tab blur; explicit "abandon run" guard so a closed tab never eats a mid-mission run silently (offer "resume" on return).

## 5. Example Command Flow

Here is an example of how a fast-paced, brain-engaging infiltration sequence looks:

```
> scan network
[+] Found Node: 192.168.1.45 (Firewall Level 1)

> breach 192.168.1.45
[!] Initiating sequence... Complete the pattern: [2] [4] [8] [??]
> input 16
[+] Breach successful. Access granted.

> ls
finance_data.enc system_logs

> scp finance_data.enc local
[+] Download complete. TRACE AT 65%... WARNING!

> rm system_logs
[+] Tracks cleared.

> exit
[-] Disconnected safely.
```

**v2 — the same run, with the tension layer visible (HUD annotations in brackets):**

```
> connect 192.168.1.0/24          [TRACE 4% — slow creep on foreign subnet]
> scan                            [map renders: 3 nodes. vault = high sec, high loot]
> breach 192.168.1.45             [puzzle: port-knock. TRACE +8]
> download vault_keys.enc         [TRACE +5/s while transferring — meter visibly climbs]
[!] Admin ping detected. Trace accelerating.
> proxy hop                       [one-time decoy. TRACE 71% → 52%]
> download payroll.db             [the greedy choice — do I have room?]
[!!] TRACE 89% — COUNTER-TRACE DAEMON ACTIVE      [alarm audio layer kicks in]
> rm /var/log/auth.log
> disconnect
[+] CLEAN EXIT · extraction bonus +$400           [green flash, music resolves]
```

## 6. Minimum Viable Product (MVP) Scope (1-Week Goal)

Utilizing AI assistance, the 1-week build will include:

1. A working Xterm.js frontend with a React HUD (no backend — see §4.2).
2. A basic Virtual File System (VFS) with standard navigation (`cd`, `ls`, `cat`, `rm`).
3. **Three puzzle types** (sequence, port-knock memory, cipher — §8) instead of one, to validate variety early.
4. **One topology archetype** (linear chain) + seeded procedural missions with scaling loot/security.
5. **The full trace/tension system** (§7) — meter, escalation events, clean-exit bonus. This is the game; it ships in MVP, not after it.
6. **Scripted 90-second tutorial mission** (§11).
7. **HUD v1:** trace meter, mission objective, cash/loot readout, node map.
8. **Basic audio:** keyclicks, success/fail stings, rising alarm tied to trace (Web Audio, no assets needed — synthesized).
9. localStorage progression (cash, XP, rank title).

**Explicitly cut from MVP** (and why): backend/leaderboards (no server needed to validate fun), upgrade shop (needs economy balance data first), narrative campaign (one handler intro is enough for week 1), daily challenges, mobile input mode.

---

# New Systems (v2)

## 7. Trace & Tension System (the heart of the game)

The trace meter (0–100%) is the single most important UI element. Rules are fully legible — the player always knows what raises it and by how much.

**Trace sources:**
| Action | Trace effect |
|---|---|
| Breaching a node | +8 to +15 (scales with security level) |
| Failed puzzle / wrong breach input | +15 (mistakes sting but never dead-end) |
| Downloading files | +5/second *while transferring* |
| Idle time on a foreign network | +1/second baseline |
| Deleting logs (`rm /var/log/...`) | −8 per log (cleanup buys margin, costs time) |

**Escalation thresholds (the difficulty curve inside every mission):**
- **0–49% — Quiet.** Ambient hum. Baseline creep.
- **50% — Watchdog spawns.** A patrolling daemon appears on the map; breaching its current node costs double. First real "oh no."
- **75% — Admin alert.** Trace creep doubles, screen edge pulses red, alarm pitch rises. The player should feel their pulse here.
- **100% — Busted.** Not a dead screen: a dramatic forced-disconnect cutscene, lose mission loot, keep 50% XP, shown *"Trace was at 92% — so close."* One-keypress instant retry.

**Escape tools (economy of panic):** `proxy hop` (one per mission, big trace reduction), `decoy` (spawns a fake target that occupies the watchdog), `sleep <node>` (hide and let creep slow). These are bought/upgraded in the meta shop (§10) — being better equipped turns panics into controlled escapes, which *is* the power fantasy.

**Clean-exit bonus:** finishing under 50% trace multiplies mission payout. Risk/reward is now a scoring system, not just survival.

## 8. Puzzle System (diegetic, escalating, skippable)

**Principle: puzzles live inside the fiction.** The firewall *is* the lock — no detached minigame popups that break flow.

| Tier | Puzzle family | Fiction | Skill | Debuts |
|---|---|---|---|---|
| 1 | **Sequence completion** | "Packet interval lock" — `[2] [4] [8] [??]` | Numeric patterns | Tutorial |
| 1 | **Port-knock memory** | Repeat the glowing port sequence (Simon-says, length 4→7) | Memory | Mission 1 |
| 2 | **Cipher lock** | Decode a short word from a plaque (Caesar / keyword) | Pattern recognition | Week 1 |
| 2 | **Connection maze** | Rotate nodes to route power from A to B | Spatial | Phase 2 |
| 3 | **Password audit** | Pick the one string satisfying 3 displayed rules | Reading/logic | Phase 2 |
| 3 | **Priv-esc chain** | Order 4 exploits correctly using clues from recon data | Synthesis | Phase 3 |

**Anti-repetition rules (this is what keeps minute 30 fun):**
- Puzzles are **shorter or auto-assisted once a node's security is below your tools' rating** — upgrades literally make old locks trivial. Power growth is felt as *speed*.
- Time-box each puzzle (e.g., 30s) with visible fuse; timeout = fail (trace +15) but never a mission-wipe.
- `skip` and `hint` are always available (trace/cash cost) — pillar 5.
- Generation mutates families: multi-stage puzzles (two locks on a tier-3 node), and *negative* variants ("pick the port that does NOT match").

## 9. Command Grammar (full verb table)

**MVP verbs (teach these 8):**

| Command | Effect |
|---|---|
| `help` / `man <cmd>` | One-screen verb list / themed manual page |
| `scan` | Reveal network map, node security & loot values |
| `connect <ip>` | Enter a node (adds baseline trace) |
| `breach <ip>` | Start firewall puzzle |
| `ls` / `cd <dir>` | Navigate the VFS |
| `cat <file>` | Read a file (lore, clues, mission intel) |
| `download <file>` | Exfiltrate (trace +5/s during transfer) |
| `rm <path>` | Delete logs / decoys (reduces trace) |
| `disconnect` | End mission, trigger scoring |

**Phase 2 unlocks (each is a shop purchase → new verb = visible progression):** `proxy hop`, `decoy`, `crack <file>` (encrypted loot), `ps` / `kill <pid>` (fight daemons), `spoof <id>` (bypass watchdog), `implant <node>` (persistent backdoor across missions — changes future mission starts).

**Phase 3:** `netmap`, `trace` (show trace source), `alias`, missions with *no* `scan` allowed (dark runs — pure memory).

## 10. Progression, Economy & Meta

- **Currency:** missions pay cash (base × difficulty × clean-exit multiplier). Cash buys tools (§9) and upgrades (faster transfers, trace decay, extra proxy hop, puzzle time +10s).
- **XP & ranks:** Script Kiddie → Operator → Breacher → Ghost → Elite Operator. Ranks gate mission difficulty tiers and are displayed on leaderboards.
- **Unlock pacing:** new verbs arrive roughly every 2–3 missions early on. The tutorial introduces 6 verbs invisibly; the shop teaches the rest. Players should meet a lock they *want* to open before they get the key.
- **Daily challenge (Phase 2):** date-seeded mission, same for everyone, one attempt, leaderboard by score = loot + time + clean-exit bonus. This is the retention engine.
- **Story missions + endless mode:** a 20-mission narrative arc (§12) for direction, then infinite procedural contracts for mastery.

## 11. Onboarding: The First 60 Seconds

- **Boot sequence (skippable, ~4s):** fake BIOS text, logo glitch, handler message: *"You're in. Type `scan`."*
- **Mission 0 is scripted, ~90 seconds, cannot be failed:** the next command is always glow-highlighted; pressing TAB fills it; one puzzle is forced-success on first try. The player *feels* competent before they understand anything.
- **No walls of text.** All teaching happens at the prompt, one verb at a time. A "Skip intro" link serves veterans. Target: ≥85% of new players reach first breach.

## 12. Narrative Frame (light, skippable, atmospheric)

Zero-install story that gives mission 20 a reason to exist:

- **Setup:** the player is a freelance operator taking contracts from **the Broker** through a burner terminal.
- **Handler chat:** 2–3 line messages between missions (fully skippable). Tone: dry, complicit, occasionally ominous.
- **Arc:** routine jobs → the player finds *their own name* in a vault file → who set them up? 20 missions to the answer. Missions remain procedural under the hood; only objectives, targets, and flavor change.
- **World lore in the VFS:** `cat`-able emails, memos, and rants on hacked servers. Purely optional; rewards exploration; occasionally contains puzzle hints (exploration pays).

## 13. Juice, Presentation & Audio (first-class, not polish)

Terminal games are made or broken by *text feel*. Budget: one full day of the MVP week.

- **Text:** typewriter output (~2ms/char, any keypress completes instantly), color language (green `+` = good, red `−` = bad, amber = warning — consistent forever), per-mission ASCII banner, glitch effect on trace spikes, CRT scanline + vignette overlay (toggleable).
- **Motion:** HUD updates on transforms only; screen shake (subtle!) at trace ≥75%; success flash on clean exit. Full **reduced-motion mode** honors `prefers-reduced-motion`.
- **Audio (all synthesized via Web Audio — no asset pipeline):** mechanical keyclick on every keystroke; ascending two-note sting on success, harsh buzz on fail; alarm that *rises in pitch with trace %*; music as layered stems that add layers as tension climbs and resolve on clean exit. Volume sliders + full mute, persisted.
- **Accessibility:** colorblind-safe palette option (shapes/labels, never color-only meaning), adjustable text speed, high-contrast mode.

## 14. HUD & Screen Layout

```
┌──────────────────────────────────────────────────────────────┐
│ MISSION: "Silent Ledger"      TRACE ▓▓▓▓▓▓░░░░ 63%   $12,450 │
├───────────────┬──────────────────────────────┬───────────────┤
│  NETWORK MAP  │                              │  OBJECTIVES   │
│  ● gw (sec 1) │                              │  □ vault_keys │
│  ●─● files    │         TERMINAL             │  ☐ payroll.db │
│    ● vault    │        (the star)            │  ☐ wipe logs  │
│  ◌ watchdog   │                              ├───────────────┤
│               │                              │  HANDLER chat │
└───────────────┴──────────────────────────────┴───────────────┘
```

- Terminal owns ~60% of width and all focus; HUD is peripheral glow, never a wall of panels.
- Trace meter doubles as the escalation alarm: color shifts + pulse at thresholds.
- Map nodes show live state (breached/locked/watchdog-present). Clicking a node focuses it but does **not** act for the player — the terminal stays the only verb instrument.

## 15. Mission Grammar & Procedural Generation

Missions are assembled from three axes so content multiplies without authoring:

- **Objective archetypes:** steal N files · wipe evidence (rm, no download) · plant a daemon · *identity heist* (steal 3 specific files from 3 different subnets) · *data hostage* (file is being deleted on a visible countdown).
- **Topology archetypes:** linear chain (MVP) · hub-and-spoke (route choice) · deep tree (commitment decisions) · ring (two ways in — and two ways out).
- **Modifiers:** ICE present (extra puzzle tier) · dark network (`scan` disabled) · decoy files (one fake loot poisons trace fast) · rival ghost (a scripted competitor racing you on the map) · hardened logs (rm takes 3s during which you're exposed).

Generation draws seed → topology → objective + modifier appropriate to player rank, then validates solvability (the engine simulates a perfect run; every generated mission must be completable with margin).

## 16. Failure, Difficulty & Anti-Frustration

- **Runs are short (3–8 minutes)** by design: failure costs minutes, not evenings. Roguelite rhythm.
- **Busting is informative:** post-mission screen always shows *why* (trace breakdown: which action burned you) and offers instant retry.
- **Difficulty modes:** Casual (puzzle timer off, trace creep −30%) · Standard · Hard (dark networks, tighter thresholds — for leaderboard scoring).
- **Never dead-end:** skip/hint always available; VFS never requires knowledge outside the game (`man` covers every verb).
- **Tuning targets:** mission completion ≥70%, puzzle skip rate 10–20% (below 10% = too easy, above 20% = too hard), median session ≥2 missions.

## 17. Metrics & Playtesting (how we'll know it's fun)

| Signal | Target | If missed |
|---|---|---|
| Time to first successful breach | < 90s from load | Simplify tutorial; cut boot copy |
| Tutorial completion | ≥ 85% | Reduce forced steps |
| Mission completion rate | ≥ 70% | Lower tier-2 security frequency |
| Puzzle skip rate | 10–20% | Retune puzzle time-boxes |
| Median missions/session | ≥ 2 | Check difficulty cliff at rank 2 |
| D1 retention (Phase 2, with daily) | ≥ 25% | Strengthen daily hook |

Cadence: weekly 5-person playtests from MVP week 1 onward; watch for *silent* frustration (long pauses, repeated `help`) more than complaints.

## 18. Roadmap

- **Week 1 — MVP (playable, deployable, fun):** engine + 3 puzzle families + linear topology + 8 verbs + full trace system + HUD v1 + tutorial + 10 seeded missions + synth audio. *Exit criteria: a stranger completes a mission unassisted and says "one more."*
- **Weeks 2–4 — Meta:** upgrade shop, all 6 puzzle families, 3 topologies, modifiers, narrative arc (20 missions), daily challenge + leaderboards (first backend), layered music.
- **Phase 3:** ghost races, implant backdoors across missions, seasonal events, mobile input mode (tap-suggested command chips — explicit design task, not a port), localization.

## 19. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Puzzle repetition kills retention | 6 families × modifiers × auto-simplify via upgrades (§8) |
| Difficulty tuning by feel fails | Telemetry targets + skip-rate signal (§16, §17) |
| Scope creep (backend in MVP) | Client-first architecture; server only where it creates value (§4.2) |
| Browser autoplay blocks audio | Audio starts on first interaction; game never depends on sound |
| "Terminal = nerdy" ceilings reach | Pillars 1 & 5: 10-second fantasy, never hard-stuck, no typing skill required |
| xterm.js on mobile | Desktop-first declared; mobile is a designed Phase 3 mode |

---

## Appendix: v1 → v2 Change Log

1. **Positioning sharpened:** CyberGrid is a tension game; the trace meter is the product.
2. **Loop expanded** from 3 phases to 4 (Escape) with an explicit decision layer after Recon.
3. **Trace system fully specified** — costs per action, escalation events at 50/75/100%, escape tools, clean-exit scoring.
4. **Puzzle system designed** — 6 diegetic families across 3 tiers, anti-repetition rules, skip/hint always available.
5. **Command grammar table added** — 8 MVP verbs, progression via purchased new verbs.
6. **Progression meta added** — cash economy, upgrade shop, ranks, daily challenge.
7. **Narrative frame added** — the Broker, 20-mission arc, lore in the VFS.
8. **Onboarding, failure design, difficulty modes** specified.
9. **Juice & audio promoted to first-class scope** with a day reserved in MVP week.
10. **Architecture revised** — MVP is 100% client-side (backend cut from week 1); seeded deterministic engine; Phase 2 adds server for dailies/leaderboards.
11. **Fun metrics and tuning targets added**; roadmap exit criteria defined; risk register added.
