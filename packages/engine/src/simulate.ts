import { CONFIG } from './config.js';
import { GameEngine } from './game.js';
import { campaignDescriptor, customDescriptor, dailyDescriptor, describeDescriptor } from './identity.js';
import { playOracle, routesFor, type OracleOptions, type SimResult } from './validate.js';
import type { Loadout, MissionDescriptor } from './types.js';

/**
 * Deterministic simulation scenarios (F10/E07). Scripted operator policies play
 * a bounded corpus of missions through the real engine. The output is a tuning
 * aid, not proof of fun: it says whether jobs stay winnable for imperfect
 * players, whether fork routes and modules actually trade off, and how long
 * runs take with simulated think time. `npm run sim` prints the report.
 */

export interface Policy {
  id: string;
  label: string;
  options: OracleOptions;
}

const STOCK: Loadout = { module: null, upgrades: {} };
const MID: Loadout = { module: null, upgrades: { overclock: 1, crowbar: 1 } };

export const POLICIES: Policy[] = [
  { id: 'oracle', label: 'perfect (validator policy)', options: { loadout: STOCK } },
  { id: 'cautious', label: 'cautious: 2.5× think time', options: { loadout: STOCK, thinkScale: 2.5 } },
  { id: 'one-mistake', label: 'one wrong answer, 1.5× think', options: { loadout: STOCK, mistakes: 1, thinkScale: 1.5 } },
  { id: 'sloppy', label: 'three wrong answers, 2× think', options: { loadout: MID, mistakes: 3, thinkScale: 2 } },
  { id: 'human-paced', label: 'one mistake, 6× think (≈ human reading pace)', options: { loadout: STOCK, mistakes: 1, thinkScale: 6 } },
  { id: 'greedy', label: 'greedy: optional loot + vault', options: { loadout: STOCK, greed: true } },
  { id: 'no-tools', label: 'never uses proxy/decoy, no log wipes', options: { loadout: STOCK, tools: false, wipeLogs: false } },
];

export const LOADOUTS: { id: string; loadout: Loadout }[] = [
  { id: 'stock', loadout: STOCK },
  { id: 'burst', loadout: { module: 'burst', upgrades: {} } },
  { id: 'quiet', loadout: { module: 'quiet', upgrades: {} } },
  { id: 'maxed', loadout: { module: null, upgrades: { relay: 2, drone: 1, overclock: 3, ghosting: 2, crowbar: 2, insider: 1 } } },
];

/** The bounded corpus: the campaign, custom seeds across tiers, and three dailies. */
export function simulationCorpus(): MissionDescriptor[] {
  const out: MissionDescriptor[] = [];
  for (let i = 1; i <= CONFIG.mission.count; i++) out.push(campaignDescriptor(i));
  for (const seed of ['neon harbor', 'ALPHA', 'zz-quantum']) for (const tier of [2, 5, 8]) out.push(customDescriptor(seed, tier));
  for (const date of ['2026-01-01', '2026-06-15', '2026-10-20']) out.push(dailyDescriptor(date));
  return out;
}

export interface ScenarioResult {
  key: string;
  label: string;
  runs: number;
  completed: number;
  clean: number;
  busted: number;
  avgEndTrace: number;
  avgPeakTrace: number;
  avgSeconds: number;
  avgCash: number;
  avgTransferSeconds: number;
}

export interface SimulationReport {
  missions: number;
  policies: ScenarioResult[];
  loadouts: ScenarioResult[];
  routes: ScenarioResult[];
  /** Per mission, oracle results — useful when a single job is suspect. */
  perMission: { label: string; outcome: string; endTrace: number; seconds: number }[];
}

function summarize(key: string, label: string, sims: SimResult[]): ScenarioResult {
  const n = Math.max(1, sims.length);
  const avg = (f: (s: SimResult) => number) => Math.round((sims.reduce((a, s) => a + f(s), 0) / n) * 10) / 10;
  return {
    key,
    label,
    runs: sims.length,
    completed: sims.filter((s) => s.objectiveComplete && !s.busted).length,
    clean: sims.filter((s) => s.outcome === 'clean').length,
    busted: sims.filter((s) => s.busted).length,
    avgEndTrace: avg((s) => s.traceEnd),
    avgPeakTrace: avg((s) => s.traceMax),
    avgSeconds: avg((s) => s.activeSeconds),
    avgCash: avg((s) => s.cash),
    avgTransferSeconds: avg((s) => s.transferSeconds),
  };
}

export function runSimulation(descs: MissionDescriptor[] = simulationCorpus()): SimulationReport {
  const engine = new GameEngine({ fast: true, now: () => 0 });
  const specs = descs.map((d) => ({ d, spec: engine.specFor(d) }));
  const policies = POLICIES.map((p) =>
    summarize(p.id, p.label, specs.map(({ spec }) => playOracle(spec, { ...p.options, practice: true })))
  );
  const loadouts = LOADOUTS.map((l) =>
    summarize(l.id, `greedy run, ${l.id} rig`, specs.map(({ spec }) => playOracle(spec, { loadout: l.loadout, greed: true, practice: true })))
  );
  const forks = specs.filter(({ spec }) => routesFor(spec).length > 1);
  const routes = (['long', 'hot'] as const).map((route) =>
    summarize(route, `${route} road on ${forks.length} forked jobs`, forks.map(({ spec }) => playOracle(spec, { route, loadout: STOCK, thinkScale: 1.5, practice: true })))
  );
  const perMission = specs.map(({ d, spec }) => {
    const r = playOracle(spec, { loadout: STOCK, practice: true });
    return { label: describeDescriptor(d), outcome: r.outcome, endTrace: Math.round(r.traceEnd), seconds: r.activeSeconds };
  });
  return { missions: specs.length, policies, loadouts, routes, perMission };
}

export function formatSimulationReport(r: SimulationReport): string {
  const row = (s: ScenarioResult) =>
    `  ${s.key.padEnd(12)} ${`${s.completed}/${s.runs}`.padStart(6)} ${String(s.clean).padStart(6)} ${String(s.busted).padStart(6)} ${String(s.avgEndTrace).padStart(8)} ${String(s.avgPeakTrace).padStart(8)} ${String(s.avgSeconds).padStart(8)} ${String(s.avgCash).padStart(8)} ${String(s.avgTransferSeconds).padStart(7)}  ${s.label}`;
  const head = `  ${'scenario'.padEnd(12)} ${'done'.padStart(6)} ${'clean'.padStart(6)} ${'bust'.padStart(6)} ${'endTr'.padStart(8)} ${'peakTr'.padStart(8)} ${'secs'.padStart(8)} ${'cash'.padStart(8)} ${'xferS'.padStart(7)}`;
  const lines = [
    `CyberGrid simulation — ${r.missions} missions (campaign, custom tiers 2/5/8, three dailies)`,
    'Simulated operators with scripted think time. Not a substitute for human playtests.',
    '',
    'policies:',
    head,
    ...r.policies.map(row),
    '',
    'loadouts (greedy policy):',
    head,
    ...r.loadouts.map(row),
    '',
    'fork routes (1.5× think time):',
    head,
    ...r.routes.map(row),
    '',
    'per mission (perfect policy):',
    ...r.perMission.map((m) => `  ${m.outcome.padEnd(10)} ${String(m.endTrace).padStart(3)}%  ${String(m.seconds).padStart(5)}s  ${m.label}`),
  ];
  return lines.join('\n');
}
