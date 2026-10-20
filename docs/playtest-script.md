# CyberGrid — human playtest script

The agent's browser pass (`implementation-notes.md`) is not player research.
This script is for at least **5 players** who have never seen the game:
- mix terminal-comfortable and not;
- at least one keyboard-only or screen-reader user if possible;
- at least one on a phone.

**Setup.** Fresh browser profile (empty `localStorage`), sound on, the build
from `npm run build && npm run preview`. One observer per session, taking
notes. Don't help unless the player is stuck for more than 60 s, and record
every intervention.

**Think-aloud.** Ask players to say what they're thinking. Don't explain
mechanics up front.

## Session (≈ 35 min)

| # | Task (what you say) | Observe | Record |
|---|---|---|---|
| 1 | "Open it and do whatever it asks." | Do they find `tutorial`? Use TAB? Read the Broker panel? | time to finish the tutorial; TAB used (y/n); confusion points |
| 2 | "Take the first contract." | `contracts` → `run 1`, scan, first lock | time to first breach; lock answered without hint (y/n) |
| 3 | "Finish it however you like." | Do they wipe logs, watch the meter, understand clean vs hot? | outcome; trace at exit; can they explain the result screen in their own words? |
| 4 | "Keep going until you've done three more, or 15 minutes." | Fork choice on contract 4: which road, and why? Cipher clue found? | road; quotes on the choice; first bust and the reaction to retry |
| 5 | If they bust: watch. If not, after contract 4 ask them to "try to get caught on purpose." | Is the bust sequence readable? Do they retry right away? | seconds from bust to the next command; any mention of unfairness |
| 6 | "Close the tab now." Reopen it. | Do they find `resume`? Do they trust it? | resumed state matched (y/n); any surprise |
| 7 | "Look at what else there is." | `daily`, `loadout`, `shop`, `records`, `share` discovery | which they found unprompted; would they come back tomorrow? (1–5) |

**Phone players** do tasks 1–3 and 6 only. Note drawer use, typing effort, and
whether the urgent strip (trace, lock, transfer) stays readable.

**Screen-reader players** do tasks 1–3. Note:
- whether lock prompts and fuse warnings are announced in time;
- whether the transcript is navigable;
- whether map node labels make sense.

## Post-session questions (1–5 scale, plus "why")

1. How tense did the escapes feel? (1 = flat, 5 = edge of seat)
2. How fair did getting caught feel?
3. How clear was what to do next?
4. How satisfying were the locks? Which family was best, and which worst?
5. How much did you want to play one more job at the end?
6. Was there too much text, or too little? Where did you skim?
7. What did the Broker sound like to you?

## Success signals (from the plan's targets)

- ≥ 4 of 5 finish the tutorial without intervention, in under 3 min.
- First breach within 90 s of starting contract 1.
- Lock skip rate 10–20%. (`stats` shows each player's rate; screenshot it.)
- Median "one more job" ≥ 4.
- No player describes a bust as "random" or "the game cheated".

## After the sessions

Collect each player's `stats` output and `records`. Paste the `share` code of
any job that felt off.

Tally the observations per contract and per lock family. Tune only through
`packages/engine/src/config.ts`. Re-run `npm run sim` and `npm test` after any
change.
