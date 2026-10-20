# CyberGrid implementation prompt

Copy the following prompt into your coding agent from this repository's root:

---

Implement the required fixes and enhancements in `docs/cybergrid-review-and-improvement-plan.md`. Read it, the README, relevant PRD sections, and repository instructions first. Treat the review plan as the implementation brief; preserve the game's terminal-driven identity and existing engine/React separation.

**Primary product requirement: make CyberGrid very fun to play.** Treat every change as game development. CyberGrid is a text-heavy, immersive hacking game, and player enjoyment must guide its UI/UX, functionality, mechanics, writing, pacing, feedback, and progression. Build the experience around the fantasy of taking risky contracts, cracking locks, stealing secrets, and escaping under pressure. Keep the terminal and expressive text at the center; avoid turning the experience into a conventional dashboard or a collection of management screens.

Apply these requirements throughout implementation:

- Make commands feel responsive and satisfying through clear text responses, memorable Broker dialogue, readable terminal effects, and optional sound/motion. Let players accelerate or skip presentation delays.
- Keep the game rich in text, clues, atmosphere, and discoveries. Present urgent information in short, scannable bursts; make longer lore optional so reading does not become a chore under a timer.
- Make puzzles, routes, tools, and objectives create interesting decisions, fair tension, clever solutions, and rewarding escapes. Reduce repetitive typing, arbitrary punishment, grind, and confusing dead ends.
- Make onboarding enjoyable and accessible, then gradually introduce novelty and challenge. Use the HUD to support command-driven play and preserve the sense of being inside a hacking terminal.
- Make progress feel earned and replay feel fresh. Evaluate each feature by what enjoyable moment or player decision it adds; feature count and passing tests alone do not establish a fun game.

Complete all required findings **F01–F12** and enhancements **E01–E07**, following the document's phases:

1. Fix results-screen Enter handling, pending-save loss, incomplete resume, inaccessible cipher clues, empty-run XP, misleading early-exit results, campaign completion, and panic tools during locks. Add regressions, including real keyboard-driven progression to contract 2.
2. Introduce versioned mission/share identities and complete save migration/restoration. Preserve current cash, XP, purchases, settings, cleared contracts, and legacy active missions. Sharing, retrying, and resuming must reproduce the same mission independently of player progress.
3. Add persistent puzzle/transfer/risk status, a compact responsive layout, accessible node inspection, and reliable command entry. Keep gameplay commands intentional and honor mute/reduced motion.
4. Add explicit network edges, chain and fork/rejoin missions, optional vaults, dossier extraction, payload upload, and the two documented modifiers. Update commands, map, watchdog, scoring, saves, and solvability validation together.
5. Add the documented equipment slot and tradeoff modules while preserving permanent upgrades; campaign/custom/daily mode rules; a proper campaign ending; bounded local records; a reproducible UTC daily challenge with fixed equipment and recorded-attempt/practice behavior; and corrected local stats/balance scenarios.
6. Extract focused domain modules as needed, assess bundle loading with measurements, and update documentation to match shipped behavior.

Use the plan's defaults and acceptance criteria to resolve routine choices. Keep the application client-side. The optional future backlog in section 10 is excluded. Do not deploy or publish anything as part of this task.

Work through all phases; do not stop after proposing a plan or fixing only the first bug. Do not reset existing saves, substitute placeholders, or claim human playtest results. If an external limitation prevents a check, finish unaffected work and report exactly what remains unverified.

Run the full unit suite, type checks, production build, new browser journeys, and deterministic simulation checks. Add documented commands for the new checks. Also play through the experience in a browser when available: check the tutorial, several missions, a tense escape, a failure/retry, and the progression/replay loop for clarity, pacing, repetition, and satisfying feedback. Refine friction found during that pass and document what was actually observed; distinguish the agent's playthrough from human player research. Deliver working code and a concise implementation report mapping completed F/E IDs to changes, test results, migration behavior, tuning decisions, improvements to the play experience, and remaining limitations.

---
