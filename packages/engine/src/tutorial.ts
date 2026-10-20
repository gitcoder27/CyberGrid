import { CONFIG } from './config.js';
import type { MissionSpec } from './types.js';
import { Vfs } from './vfs.js';

/**
 * The scripted ~90-second tutorial (PRD §11): Mission 0, cannot be failed.
 * Every step suggests the next command (UI glows it, TAB fills it), and the
 * single breach lock is forced-success on the first graded attempt.
 */
export function tutorialMission(): MissionSpec {
  const entryRoot = Vfs.specRoot('gatewatch', []);

  const nodeRoot = Vfs.specRoot('ledgercube', [
    {
      name: 'srv',
      files: [
        {
          name: 'ledger.dat',
          tag: 'target',
          value: CONFIG.economy.cashPerFileBySecurity[1]!,
          targetId: 'target-1',
        },
        {
          name: 'memo.txt',
          tag: 'plain',
          content:
            'memo: if you are reading this from outside the building, please stop.\n management',
        },
      ],
      dirs: [],
    },
  ]);
  const varDir = nodeRoot.dirs!.find((d) => d.name === 'var')!;
  varDir.dirs!.find((d) => d.name === 'log')!.files = [
    {
      name: 'auth.log',
      tag: 'log',
      content: 'session records. foreign handshake signatures present.',
    },
  ];

  return {
    kind: 'tutorial',
    index: 0,
    seed: CONFIG.tutorial.seed,
    name: 'Warm-Up: The Ledger',
    codename: 'Warm-Up',
    brief:
      'A guided job on a friendly little box. Follow the glow: the next command is always ' +
      'highlighted, and TAB fills it in for you.',
    handlerLines: [
      'You\'re in. That glow around a command? That\'s your next move.',
      'Type it — or press TAB and let the terminal do the typing.',
    ],
    nodes: [
      {
        id: 'n0',
        ip: '10.0.0.1',
        hostname: 'gatewatch',
        security: 0,
        puzzleFamily: 'sequence',
        root: entryRoot,
      },
      {
        id: 'n1',
        ip: '10.0.0.12',
        hostname: 'ledgercube',
        security: 1,
        puzzleFamily: 'sequence',
        root: nodeRoot,
      },
    ],
    targetIds: ['target-1'],
    requiredTargets: 1,
    puzzleAnswers: {
      n1: { family: 'sequence', terms: [2, 4, 8], answer: 16, rule: 'constant ratio' },
    },
  };
}

/** The tutorial script: expected next commands, in order (normalized).
 *  `advanceOn` names the engine moment that completes the step. */
export const TUTORIAL_STEPS: { cmd: string[]; note?: string; advanceOn: string }[] = [
  { cmd: ['scan'], note: 'see the network first', advanceOn: 'scan' },
  { cmd: ['breach', '10.0.0.12'], note: 'take the node', advanceOn: 'breach' },
  { cmd: ['input', '16'], note: 'answer the lock', advanceOn: 'input' },
  { cmd: ['ls'], note: 'look around', advanceOn: 'ls' },
  { cmd: ['cd', 'srv'], note: 'into the share', advanceOn: 'cd' },
  { cmd: ['download', 'ledger.dat'], note: 'take the file', advanceOn: 'download-complete' },
  { cmd: ['rm', '/var/log/auth.log'], note: 'burn your tracks', advanceOn: 'rm-log' },
  { cmd: ['disconnect'], note: 'go home', advanceOn: 'disconnect' },
];
