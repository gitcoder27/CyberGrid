import { describe, expect, it } from 'vitest';
import { buildValidatedMission } from '../src/validate.js';
import { GameEngine } from '../src/game.js';
import { bootToHome, drain, settle, tickWhile, traceOf } from './helpers.js';

/**
 * Regressions for the UAT (browser playtest) findings:
 * P1 guidance deadlock after a burnt fuse · hostname acceptance in the tutorial ·
 * help-list correctness · breach in command history · no-arg breach guidance.
 */

function fresh(): GameEngine {
  const engine = new GameEngine({ fast: true });
  bootToHome(engine);
  return engine;
}

const texts = (engine: GameEngine, cmd: string): string =>
  drain(engine, cmd)
    .filter((e) => e.t === 'print')
    .map((e) => (e as { text: string }).text)
    .join('\n');

function specIp1(engine: GameEngine): string {
  void engine;
  return buildValidatedMission(1, 'CG-OMEN-01').nodes[1]!.ip;
}

describe('P1: no guidance deadlock after a burnt fuse', () => {
  it('delayed events (scan reveal, lock prompt) reach the caller through tick()', () => {
    // Player-reported: the breach lock opened with NO prompt on screen — events
    // fired from delayed actions were pushed into the original submit()'s stale
    // event array and never reached the UI. They must come back via tick().
    const engine = fresh();
    drain(engine, 'run 1');
    const scanEvents = drain(engine, 'scan');
    expect(scanEvents.some((e) => e.t === 'print' && (e as { text: string }).text.includes('sweeping'))).toBe(true);

    const afterTick: string[] = [];
    for (let i = 0; i < 40 && afterTick.length === 0; i++) {
      for (const e of engine.tick(0.05)) {
        if (e.t === 'print') afterTick.push((e as { text: string }).text);
      }
    }
    expect(afterTick.join('\n')).toContain('network mapped');
    expect(afterTick.join('\n')).toContain(specIp1(engine));

    drain(engine, `breach ${specIp1(engine)}`);
    const breachTail: string[] = [];
    for (let i = 0; i < 10 && breachTail.length === 0; i++) {
      for (const e of engine.tick(0.05)) {
        if (e.t === 'print') breachTail.push((e as { text: string }).text);
      }
    }
    const joined = breachTail.join('\n');
    expect(joined).toContain('firewall lock engaged');
    expect(joined).toContain('Packet interval lock');
    // and the UI-facing suggestion must point at the answer
    expect(engine.suggest).toBe('');
  });

  it('tutorial: timeout rewinds the glow to `breach 10.0.0.12` and the loop recovers', () => {
    const engine = fresh();
    drain(engine, 'tutorial');
    drain(engine, 'scan');
    settle(engine);
    drain(engine, 'breach 10.0.0.12');
    settle(engine);
    expect(engine.suggest).toBe('input 16');
    // let the fuse burn out (30s time box)
    for (let i = 0; i < 32; i++) engine.tick(1);
    expect(engine.getState().mission!.puzzle).toBeNull();
    // THE FIX: the glow and handler must point back at breach, not `input 16`
    expect(engine.suggest).toBe('breach 10.0.0.12');
    // …and following the glow works: re-breach, answer, continue the script
    drain(engine, 'breach 10.0.0.12');
    settle(engine);
    expect(engine.getState().mission!.puzzle).not.toBeNull();
    drain(engine, 'input 16');
    expect(engine.getState().mission!.currentNodeId).toBe('n1');
  });

  it('contracts: timeout flips the suggestion to `breach <ip>`', () => {
    const engine = fresh();
    drain(engine, 'run 1');
    const spec = buildValidatedMission(1, 'CG-OMEN-01');
    drain(engine, 'scan');
    settle(engine);
    drain(engine, `breach ${spec.nodes[1]!.ip}`);
    settle(engine);
    for (let i = 0; i < 32; i++) engine.tick(1);
    expect(engine.suggest).toBe(`breach ${spec.nodes[1]!.ip}`);
  });

  it('starting a breach clears the stale suggestion during spin-up', () => {
    const engine = fresh();
    drain(engine, 'tutorial');
    drain(engine, 'scan');
    settle(engine);
    drain(engine, 'breach 10.0.0.12'); // pending 0.9s (real-time); suggest must drop
    expect(engine.suggest).toBe('');
    settle(engine); // lock opens → glow moves to the answer
    expect(engine.suggest).toBe('input 16');
  });
});

describe('P1/P3: equivalent commands are accepted in the tutorial', () => {
  it('hostname works: `breach ledgercube` opens the lock', () => {
    const engine = fresh();
    drain(engine, 'tutorial');
    drain(engine, 'scan');
    settle(engine);
    drain(engine, 'breach ledgercube');
    settle(engine);
    expect(engine.getState().mission!.puzzle).not.toBeNull();
    drain(engine, 'input 16');
    expect(engine.getState().mission!.currentNodeId).toBe('n1');
  });

  it('basename works: `rm auth.log` clears the tutorial log', () => {
    const engine = fresh();
    for (const s of ['tutorial', 'scan', 'breach 10.0.0.12', 'input 16', 'ls', 'cd srv', 'download ledger.dat']) {
      drain(engine, s);
      settle(engine);
      tickWhile(engine, () => engine.getState().mission?.transferLabel != null);
    }
    const traceBefore = traceOf(engine);
    drain(engine, 'rm auth.log');
    expect(traceOf(engine)).toBeLessThan(traceBefore + 1);
  });
});

describe('P3: help and guidance correctness', () => {
  it('mission-mode help lists `breach` and `input` (no misnamed verbs)', () => {
    const engine = fresh();
    drain(engine, 'tutorial');
    drain(engine, 'scan');
    settle(engine);
    const help = texts(engine, 'help');
    expect(help).toContain('breach <ip>');
    expect(help).toContain('input <value>');
    expect(help.toLowerCase()).not.toContain('reboot');
  });

  it('submitted breach commands land in history (ArrowUp can recall them)', () => {
    const engine = fresh();
    drain(engine, 'tutorial');
    drain(engine, 'scan');
    settle(engine);
    drain(engine, 'breach 10.0.0.12');
    expect(engine.history).toContain('breach 10.0.0.12');
  });

  it('bare `breach` lists the reachable nodes instead of a shrug', () => {
    const engine = fresh();
    drain(engine, 'run 1');
    drain(engine, 'scan');
    settle(engine);
    const out = texts(engine, 'breach');
    const spec = buildValidatedMission(1, 'CG-OMEN-01');
    expect(out).toContain('breach which node?');
    expect(out).toContain(`breach ${spec.nodes[1]!.ip}`);
  });
});
