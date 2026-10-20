/**
 * Playthrough harness (not a normal test — it PRINTS the game): drives the real
 * Bridge (the exact object the React app uses) through boot → tutorial →
 * contract 1 and dumps the terminal transcript + HUD state, so the game can be
 * reviewed for feel without a browser.
 */
import { it } from 'vitest';
import { Bridge } from '../../../app/src/engine/bridge.js';
import type { SaveBlobV1 } from '../src/types.js';
import { TELEMETRY_DEFAULT } from '../src/types.js';

const save: SaveBlobV1 = {
  version: 1,
  profile: { cash: 0, xp: 0, contractsDone: 0, tutorialDone: false, upgrades: {}, telemetry: { ...TELEMETRY_DEFAULT } },
  settings: { volume: 0.8, muted: false, crt: true, motion: true },
  history: [],
  session: null,
};

const bridge = new Bridge({ load: () => save, save: (b) => Object.assign(save, b) });

const COLORS: Record<string, (s: string) => string> = {
  good: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  accent: (s) => `\x1b[36m${s}\x1b[0m`,
  sys: (s) => `\x1b[35m${s}\x1b[0m`,
  handler: (s) => `\x1b[33m${s}\x1b[0m`,
  banner: (s) => `\x1b[95m${s}\x1b[0m`,
  loot: (s) => `\x1b[92m${s}\x1b[0m`,
  log: (s) => `\x1b[93m${s}\x1b[0m`,
  info: (s) => s,
};

function flush(dtSeconds: number): void {
  const frames = Math.ceil((dtSeconds * 1000) / 16);
  for (let i = 0; i < frames; i++) {
    bridge.frame(16);
    for (const e of bridge.printQueue.splice(0)) {
      if (e.t === 'print') {
        const paint = COLORS[e.cls ?? 'info'] ?? COLORS.info;
        for (const line of e.text.split('\n')) console.log(paint(line));
      } else if (e.t === 'progress') {
        const cells = Math.round(e.pct / 10);
        console.log(`\x1b[36m  ⇣ ${e.label} ${'█'.repeat(cells)}${'░'.repeat(10 - cells)} ${e.pct}%\x1b[0m`);
      } else if (e.t === 'clear') {
        console.log('── screen cleared ──');
      }
    }
    for (const f of bridge.fxQueue.splice(0)) {
      if (f.kind === 'sfx' && f.name === 'alarm') console.log('\x1b[41m  ♪ ALARM ♪\x1b[0m');
      if (f.kind === 'shake') console.log('  ~~ screen shake ~~');
    }
    for (const h of bridge.handlerQueue.splice(0)) {
      console.log(`  [HUD handler] ${h}`);
    }
  }
}

function player(cmd: string, thinkSeconds = 2): void {
  console.log(`\n\x1b[2m── ${bridge.snapshot.prompt} ${cmd}\x1b[0m`);
  flush(0.1);
  bridge.submit(cmd);
  flush(Math.max(0.4, thinkSeconds));
  const m = bridge.snapshot.mission;
  const hud = m
    ? `trace ${m.trace}% [${m.phase}] · stolen ${m.stolen}/${m.required} · node ${m.currentNodeId} · $${m.sessionCash}${m.watchdogNodeId ? ' · ⚠wd@' + m.watchdogNodeId : ''}`
    : `mode=${bridge.snapshot.mode}`;
  console.log(`\x1b[2m   [HUD] ${hud}\x1b[0m`);
}

it('playthrough: boot → tutorial → contract 1', () => {
  console.log('════════════ BOOT (any key skips) ════════════');
  bridge.submit(''); // player presses a key
  flush(4);

  console.log('\n════════════ TUTORIAL ════════════');
  const tutorial: [string, number][] = [
    ['tutorial', 1],
    ['scan', 3],
    ['breach 10.0.0.12', 2],
    ['input 16', 4],
    ['ls', 2],
    ['cd srv', 1],
    ['download ledger.dat', 3],
    ['rm /var/log/auth.log', 2],
    ['disconnect', 3],
  ];
  for (const [cmd, think] of tutorial) player(cmd, think);

  console.log('\n════════════ CONTRACT 1 ════════════');
  for (const [cmd, think] of [
    ['contracts', 2],
    ['run 1', 2],
    ['scan', 4],
  ] as [string, number][]) {
    player(cmd, think);
  }

  // grab the validated spec for the answer key and play it like a decent player
  const spec = bridge.engine.getValidatedSpec(1, 'CG-OMEN-01');
  for (let i = 1; i < spec.nodes.length; i++) {
    if (bridge.snapshot.mode !== 'mission') break;
    const node = spec.nodes[i]!;
    if (bridge.snapshot.mission!.nodes[i]?.status === 'locked') {
      player(`breach ${node.ip}`, 2);
      if (bridge.snapshot.mission?.puzzle) {
        const a = spec.puzzleAnswers[node.id] as { family: string; answer?: number; word?: string; ports?: number[] };
        const val =
          a.family === 'portknock'
            ? `knock ${a.ports!.join(' ')}`
            : a.family === 'cipher'
              ? `input ${a.word}`
              : `input ${a.answer}`;
        player(val, 6);
      }
    } else {
      player(`connect ${node.ip}`, 1);
    }
    // loot like a player: peek in /srv then /vault, grab flagged files
    player(`cd /srv`, 1);
    player(`ls`, 1);
    for (let pass = 0; pass < 3; pass++) {
      const m = bridge.snapshot.mission!;
      const t = m.targets.find((x) => !x.stolen && x.nodeId === node.id);
      if (!t) break;
      player(`download ${t.name}`, 4);
    }
    if (bridge.snapshot.mission!.targets.find((x) => !x.stolen && x.nodeId === node.id)) {
      player(`cd /vault`, 1);
      player(`ls`, 1);
      for (let pass = 0; pass < 3; pass++) {
        const m = bridge.snapshot.mission!;
        const t = m.targets.find((x) => !x.stolen && x.nodeId === node.id);
        if (!t) break;
        player(`download ${t.name}`, 4);
      }
    }
    player(`cd /`, 0.5);
    if ((bridge.snapshot.mission?.trace ?? 0) >= 55) player('proxy', 1);
  }
  player('disconnect', 2);

  console.log('\n════════════ FINAL STATE ════════════');
  console.log(JSON.stringify(bridge.snapshot.lastResult, null, 2));
  console.log('profile:', JSON.stringify(bridge.snapshot.profile));
  console.log('handler queue drained:', bridge.handlerQueue.length === 0);
}, 60_000);
