import { campaignDescriptor, customDescriptor } from '../src/identity.js';
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config.js';
import { GameEngine } from '../src/game.js';
import { generateMission } from '../src/missions.js';
import { buildValidatedMission } from '../src/validate.js';
import { walkSpecFilesWithPaths } from '../src/vfs.js';
import type { MissionSpec, PuzzleAnswer } from '../src/types.js';
import { bootToHome, drain, settle, tickWhile, traceOf } from './helpers.js';

function start(engine: GameEngine, spec: MissionSpec) {
  const ev: Parameters<GameEngine['startMission']>[1] = [];
  engine.startMission(spec, ev);
  return ev;
}

function solveCmd(answer: PuzzleAnswer): string {
  if (answer.family === 'portknock') return `knock ${answer.ports.join(' ')}`;
  if (answer.family === 'cipher') return `input ${answer.word}`;
  return `input ${answer.answer}`;
}

/** Breach node i of the spec and solve its lock. */
function takeNode(engine: GameEngine, spec: MissionSpec, i: number): void {
  drain(engine, `breach ${spec.nodes[i]!.ip}`);
  settle(engine);
  drain(engine, solveCmd(spec.puzzleAnswers[spec.nodes[i]!.id]!));
  settle(engine);
}

function logPaths(spec: MissionSpec, nodeId: string): string[] {
  const node = spec.nodes.find((n) => n.id === nodeId)!;
  return walkSpecFilesWithPaths(node.root)
    .filter((x) => x.file.tag === 'log')
    .map((x) => x.path);
}

describe('trace math (PRD §7)', () => {
  it('breach cost follows the security level table (wrong answers sting first)', () => {
    const engine = new GameEngine({ fast: true });
    bootToHome(engine);
    const spec = generateMission(1, 'SEC-COST');
    start(engine, spec);
    drain(engine, 'scan');
    settle(engine);
    takeNode(engine, spec, 1);
    expect(traceOf(engine)).toBeCloseTo(CONFIG.trace.breachBySecurity[spec.nodes[1]!.security]!, 1);
  });

  it('wrong puzzle input costs +15 and the lock stays open', () => {
    const engine = new GameEngine({ fast: true });
    bootToHome(engine);
    const spec = generateMission(1, 'FAIL-COST');
    start(engine, spec);
    drain(engine, 'scan');
    settle(engine);
    drain(engine, `breach ${spec.nodes[1]!.ip}`);
    settle(engine);
    expect(engine.getState().mission!.puzzle).not.toBeNull();
    drain(engine, 'input 424242');
    expect(traceOf(engine)).toBeCloseTo(CONFIG.trace.failedPuzzle, 1);
    expect(engine.getState().mission!.puzzle).not.toBeNull();
  });

  it('connect hop adds +2', () => {
    const engine = new GameEngine({ fast: true });
    bootToHome(engine);
    const spec = generateMission(1, 'HOP-COST');
    start(engine, spec);
    drain(engine, 'scan');
    settle(engine);
    takeNode(engine, spec, 1);
    const before = traceOf(engine);
    drain(engine, `connect ${spec.nodes[0]!.ip}`);
    expect(traceOf(engine)).toBeCloseTo(before + CONFIG.trace.connectHop, 1);
  });

  it('rm on a log removes 8 trace and cannot go below zero', () => {
    const engine = new GameEngine({ fast: true });
    bootToHome(engine);
    const spec = generateMission(1, 'LOG-COST');
    start(engine, spec);
    for (const p of logPaths(spec, 'n0')) drain(engine, `rm ${p}`);
    expect(traceOf(engine)).toBe(0); // clamped at zero, never negative
    takeNode(engine, spec, 1);
    const before = traceOf(engine);
    const logs = logPaths(spec, 'n1');
    if (logs.length) {
      drain(engine, `rm ${logs[0]}`);
      expect(traceOf(engine)).toBeCloseTo(Math.max(0, before + CONFIG.trace.rmLog), 1);
    }
  });

  it('downloads burn +5/s for the transfer duration (tutorial ledger: +8)', () => {
    const engine = new GameEngine({ fast: true });
    bootToHome(engine);
    drain(engine, 'tutorial');
    for (const step of ['scan', 'breach 10.0.0.12', 'input 16', 'ls', 'cd srv']) {
      drain(engine, step);
      settle(engine);
    }
    const before = traceOf(engine);
    drain(engine, 'download ledger.dat');
    tickWhile(engine, () => engine.getState().mission?.transferLabel != null);
    const expected = CONFIG.trace.downloadPerSecond * CONFIG.download.secondsPerFile;
    expect(traceOf(engine)).toBeCloseTo(before + expected, 1);
    expect(engine.getState().mission!.stolen).toBe(1);
  });

  it('idle creep accrues per second and doubles under admin alert', () => {
    const engine = new GameEngine({ fast: true });
    bootToHome(engine);
    const spec = generateMission(1, 'IDLE');
    start(engine, spec);
    for (let i = 0; i < 10; i++) engine.tick(1);
    // snapshots round trace to an integer; 10s × 0.15 ≈ 1.5 → reads as 1 or 2
    expect(traceOf(engine)).toBeGreaterThanOrEqual(1);
    expect(traceOf(engine)).toBeLessThanOrEqual(2);
    for (let i = 0; i < 600 && engine.getState().mission!.phase === 'quiet'; i++) engine.tick(1);
    expect(engine.getState().mission!.phase).toBe('watchdog');
    for (let i = 0; i < 400 && engine.getState().mission!.phase === 'watchdog'; i++) engine.tick(1);
    expect(engine.getState().mission!.phase).toBe('alert');
    const t1 = traceOf(engine);
    for (let i = 0; i < 10; i++) engine.tick(1);
    const gained = traceOf(engine) - t1;
    expect(gained).toBeGreaterThan(0);
    expect(gained).toBeLessThanOrEqual(CONFIG.trace.idlePerSecond * CONFIG.trace.alertCreepMultiplier * 10 + 0.01);
  });
});

describe('escalation & outcomes (PRD §7)', () => {
  it('watchdog spawns at 50 and breach on its node costs double', () => {
    const engine = new GameEngine({ fast: true });
    bootToHome(engine);
    const spec = generateMission(2, 'WATCHDOG');
    start(engine, spec);
    drain(engine, 'scan');
    settle(engine);
    for (let i = 0; i < 500 && (engine.getState().mission?.phase ?? 'quiet') === 'quiet'; i++) engine.tick(1);
    const snap = engine.getState().mission!;
    expect(snap.phase).toBe('watchdog');
    expect(snap.watchdogNodeId).not.toBeNull();
    const targetIdx = 1;
    const target = spec.nodes[targetIdx]!;
    const doubled = snap.watchdogNodeId === target.id;
    const traceBefore = traceOf(engine);
    drain(engine, `breach ${target.ip}`);
    settle(engine);
    drain(engine, solveCmd(spec.puzzleAnswers[target.id]!));
    settle(engine);
    const cost = CONFIG.trace.breachBySecurity[target.security as 1]! * (doubled ? 2 : 1);
    expect(traceOf(engine)).toBeGreaterThanOrEqual(traceBefore + cost - 1);
  });

  it('proxy hop reduces trace and is once per mission', () => {
    const engine = new GameEngine({ fast: true });
    bootToHome(engine);
    const spec = generateMission(2, 'PROXY');
    start(engine, spec);
    for (let i = 0; i < 400 && traceOf(engine) < 30; i++) engine.tick(1);
    const before = traceOf(engine);
    expect(before).toBeGreaterThanOrEqual(30);
    drain(engine, 'proxy');
    expect(traceOf(engine)).toBeCloseTo(before - CONFIG.tools.proxyHopReduction, 0);
    drain(engine, 'proxy');
    expect(engine.getState().mission!.tools.proxy).toBe(0);
  });

  it('busted at 100%: loot lost, xp halved, dramatic cutscene then post mode', () => {
    const engine = new GameEngine({ fast: true });
    bootToHome(engine);
    const spec = generateMission(1, 'BUSTED');
    start(engine, spec);
    drain(engine, 'scan');
    settle(engine);
    takeNode(engine, spec, 1); // 25 xp earned before the fall
    const xpBefore = engine.profile.xp;
    for (let i = 0; i < 900 && engine.mode === 'mission'; i++) engine.tick(1);
    for (let i = 0; i < 20 && engine.mode === 'mission'; i++) engine.tick(0.5);
    expect(engine.mode).toBe('post');
    const res = engine.lastResult!;
    expect(res.outcome).toBe('busted');
    expect(res.cash).toBe(0);
    expect(res.filesStolen).toBe(0);
    expect(engine.profile.xp - xpBefore).toBe(Math.round(CONFIG.economy.xpPerNode * CONFIG.economy.bustedXpFactor));
  });

  it('clean exit pays 1.5× and banks the contract unlock', () => {
    const engine = new GameEngine({ fast: true });
    bootToHome(engine);
    drain(engine, 'run 1');
    playWell(engine);
    const res = engine.lastResult!;
    expect(res.outcome).toBe('clean');
    expect(res.cash).toBeGreaterThan(0);
    expect(res.filesStolen).toBe(res.filesRequired);
    expect(engine.profile.contractsDone).toBe(1);
  });

  it('hot exit (≥50% at disconnect) keeps loot without the clean bonus', () => {
    const engine = new GameEngine({ fast: true });
    bootToHome(engine);
    drain(engine, 'run 1');
    playHot(engine);
    const res = engine.lastResult!;
    if (res.trace >= CONFIG.trace.cleanExitUnder) {
      expect(res.outcome).toBe('hot');
      expect(res.cleanBonus).toBe(0);
      expect(res.cash).toBeGreaterThan(0); // loot kept
    } else {
      expect(res.outcome).toBe('clean');
    }
  });
});

/* helpers */

/** Full clean-ish run of the CURRENT mission (a validated contract 1). */
function playWell(engine: GameEngine): void {
  const spec = currentSpec(engine);
  drain(engine, 'scan');
  settle(engine);
  for (let i = 1; i < spec.nodes.length; i++) {
    if (engine.mode !== 'mission') return;
    takeNode(engine, spec, i);
    for (const { file, path } of walkSpecFilesWithPaths(spec.nodes[i]!.root)) {
      if ((file.tag === 'target' || file.tag === 'loot') && file.targetId) {
        drain(engine, `download ${path}`);
        tickWhile(engine, () => engine.getState().mission?.transferLabel != null);
      }
    }
    for (const p of logPaths(spec, spec.nodes[i]!.id)) drain(engine, `rm ${p}`);
  }
  if (traceOf(engine) >= CONFIG.trace.cleanExitUnder) drain(engine, 'proxy');
  drain(engine, 'disconnect');
}

/** Steal only the minimum, never wipe logs, stall between breaches to heat the meter. */
function playHot(engine: GameEngine): void {
  const spec = currentSpec(engine);
  drain(engine, 'scan');
  settle(engine);
  for (let i = 1; i < spec.nodes.length; i++) {
    if (engine.mode !== 'mission') return;
    takeNode(engine, spec, i);
    for (const { file, path } of walkSpecFilesWithPaths(spec.nodes[i]!.root)) {
      if (file.tag === 'target') {
        drain(engine, `download ${path}`);
        tickWhile(engine, () => engine.getState().mission?.transferLabel != null);
      }
    }
    if (engine.getState().mission!.stolen >= engine.getState().mission!.required) break;
    for (let k = 0; k < 150 && traceOf(engine) < 55; k++) engine.tick(1);
  }
  drain(engine, 'disconnect');
}

function currentSpec(_engine: GameEngine): MissionSpec {
  // contract runs resolve through the validated-spec cache; same deterministic build
  return buildValidatedMission(campaignDescriptor(1));
}
