import { it } from 'vitest';
import { GameEngine, TELEMETRY_DEFAULT } from '../src/index.js';
import type { SaveBlob } from '../src/types.js';
import { bootToHome, drain } from './helpers.js';

it('shop transcript', () => {
  const save: SaveBlob = {
    version: 1,
    profile: {
      cash: 1800,
      xp: 0,
      contractsDone: 1,
      tutorialDone: true,
      upgrades: {},
      telemetry: { ...TELEMETRY_DEFAULT },
    },
    settings: { volume: 0.8, muted: false, crt: true, motion: true },
    history: [],
    session: null,
  };
  const engine = new GameEngine({ fast: true, save });
  bootToHome(engine);
  const show = (cmd: string) => {
    console.log(`>> ${cmd}`);
    for (const line of drain(engine, cmd)) {
      if (line.t === 'print') console.log((line as { text: string }).text);
    }
  };
  show('shop');
  show('buy relay');
  show('buy relay');
  show('profile');
  show('stats');
}, 20_000);
