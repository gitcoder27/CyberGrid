/**
 * F11 measurement: cost of GameEngine.getState() (built every frame-ish by the
 * HUD) and of tick() on a mid-mission forked network. `npx vite-node scripts/profile-snapshot.ts`
 */
import { GameEngine } from '../src/game.js';

const engine = new GameEngine({ fast: true, save: { version: 2, profile: { tutorialDone: true, contractsDone: 9, xp: 2000, cash: 0 } } as never });
engine.submit('');
engine.submit('run 10');
engine.submit('scan');
for (let i = 0; i < 10; i++) engine.tick(0.1);

const s = engine.getState();
console.log(`mode=${s.mode} nodes=${s.mission?.nodes.length ?? 0}`);

function time(label: string, n: number, fn: () => void): void {
  for (let i = 0; i < 200; i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn();
  const us = ((performance.now() - t0) / n) * 1000;
  console.log(`${label.padEnd(28)} ${us.toFixed(1)} µs/call`);
}

time('getState() mid-mission', 20000, () => engine.getState());
time('tick(1/60) mid-mission', 20000, () => engine.tick(1 / 60));
time('serialize() mid-mission', 5000, () => engine.serialize());
