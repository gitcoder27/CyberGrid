/**
 * CyberGrid — single source of truth for every tunable constant.
 * Difficulty tuning must never require touching game logic: change numbers here only.
 *
 * Two kinds of numbers live here:
 *  - RUNTIME rules (trace costs, fuses, rewards). Changing them changes how a
 *    run plays, so bump `rulesVersion` to keep personal records comparable.
 *  - GENERATION tables (`generation.v2`, `campaign`). Changing them changes
 *    which network a seed produces, i.e. mission identity. They are frozen per
 *    generation version: add a new generation instead of editing them.
 *    (Generation 1 lives, fully pinned, in gen/v1.ts.)
 *
 * Trace economy note (recorded in README):
 * PRD §7 lists idle creep at +1/s, but §16 requires 3–8 minute runs with ≥70% completion
 * and §7 requires clean exits under 50% trace. At +1/s a 3-minute run accrues 180 trace,
 * which makes every mission mathematically unwinnable. The baseline idle creep is therefore
 * retuned (see trace.idlePerSecond below); every other §7 number ships as written.
 */
export const CONFIG = {
  /** Seed prefix baked into fixed contract seeds; swap to retheme all 10 contracts. */
  season: 'OMEN',

  /** Records from different rules versions are never compared. */
  rulesVersion: 2,
  /** Generation used for new missions. */
  currentGen: 2 as 1 | 2,

  trace: {
    /** Baseline creep per second while on a foreign network (PRD retune, see header). */
    idlePerSecond: 0.15,
    /** Creep multiplier once the admin-alert escalation is active (75%+): "creep doubles". */
    alertCreepMultiplier: 2,
    /** Trace added by `connect <ip>` hopping to an already-breached node (PRD §9). */
    connectHop: 2,
    /** Breach trace indexed by node security level 0..3 (entry node is 0 / free). */
    breachBySecurity: [0, 8, 11, 15],
    /** Wrong puzzle input or puzzle timeout (PRD §7: "mistakes sting but never dead-end"). */
    failedPuzzle: 15,
    /** Trace per second while a download transfer is running (PRD §7: +5/s). */
    downloadPerSecond: 5,
    /** Trace per second while an upload runs (payload missions). */
    uploadPerSecond: 4,
    /** Transfers from the node the watchdog is sniffing cost this much more trace. */
    watchdogTransferMultiplier: 2,
    /** Trace removed per log file deleted (PRD §7). */
    rmLog: -8,
    /** `skip` on an open puzzle (PRD §3.2). */
    skipPuzzle: 25,
    /** Clean exit requires disconnecting below this trace value (PRD §7). */
    cleanExitUnder: 50,
    /** Breaching the node the watchdog currently occupies costs double (PRD §7, 50%). */
    watchdogBreachMultiplier: 2,
    /** Tutorial missions can never bust: trace clamps to this ceiling (PRD §11). */
    tutorialCap: 45,
  },

  escalation: {
    watchdogAt: 50,
    alertAt: 75,
    bustedAt: 100,
  },

  tools: {
    proxyHopReduction: 25,
    proxyHopsPerMission: 1,
    decoysPerMission: 1,
    /** Seconds the watchdog is occupied by a decoy. */
    decoyOccupySeconds: 25,
    /** Seconds between watchdog patrols (moves to a linked node). */
    watchdogMoveSeconds: 22,
  },

  /** Presentation delays (seconds). Short on purpose; any key skips typewriter text. */
  delays: {
    scan: 0.9,
    breachSpinUp: 0.7,
  },

  puzzle: {
    /** Fuse (seconds) indexed by node security level 1..3 (PRD §8 time-box). */
    timeBoxBySecurity: [0, 30, 35, 40],
    /** Port-knock sequence length by difficulty tier (PRD §8: 4 → 7). */
    knockLengthByTier: [4, 4, 5, 5, 6, 7],
    /** Cash cost of `hint`. */
    hintCost: 60,
    /** Seconds the port sequence glows before the ports go dark. */
    knockShowSeconds: 4.5,
    /** A bought knock hint re-broadcasts the sequence for this long. */
    knockHintShowSeconds: 3,
    /** Common ports the knock locks draw from. */
    knockPortPool: [22, 53, 80, 143, 443, 587, 1521, 3306, 3389, 8080, 8443, 9090],
  },

  download: {
    /** Seconds per file transfer (all files are small; drama comes from the meter). */
    secondsPerFile: 1.6,
  },

  upload: {
    /** Seconds to push a payload onto the drop point. */
    secondsPerFile: 2.2,
  },

  /** One optional slot, chosen at home, fixed for the run. Free once unlocked.
   *  Multipliers compose with the permanent overclock upgrade. */
  modules: [
    {
      id: 'burst',
      name: 'burst uplink',
      unlockRank: 'Operator',
      transferDuration: 0.8,
      transferTraceRate: 1.5,
      blurb: 'transfers 20% faster, ~20% more total transfer trace — beat the patrol to the door',
    },
    {
      id: 'quiet',
      name: 'quiet uplink',
      unlockRank: 'Breacher',
      transferDuration: 1.25,
      transferTraceRate: 0.6,
      blurb: 'transfers 25% slower, ~25% less total transfer trace — patience is camouflage',
    },
  ] as readonly ModuleDef[],

  /** Mission modifiers: at most one per job, never on introductory contracts. */
  modifiers: {
    noisy: {
      name: 'NOISY LINK',
      effect: 'transfers burn 50% more trace',
      transferTraceMultiplier: 1.5,
      bonus: 180,
    },
    patrol: {
      name: 'ACTIVE PATROL',
      effect: 'a watchdog patrols from the start and moves twice as fast',
      watchdogMoveMultiplier: 0.5,
      bonus: 180,
    },
  },

  /** Reward policy per mode. Only campaign completion advances the campaign. */
  modes: {
    campaignBonusFactor: 1,
    customBonusFactor: 0.5,
    dailyBonusFactor: 1,
    dailyPracticeBonusFactor: 0.5,
    /** Difficulty for a bare `run seed <SEED>` (fixed — never your progress). */
    customDefaultTier: 4,
  },

  daily: {
    /** Introductory mid-tier difficulty, the same for everyone. */
    tier: 5,
    /** Fixed starter rig: no module, no permanent upgrades. */
    loadout: { module: null, upgrades: {} } as { module: null; upgrades: Record<string, number> },
    /** How many dates of attempt history to keep. */
    keepDays: 30,
  },

  records: {
    recentMax: 20,
    bestMax: 80,
  },

  /** Simulated "operator think time" per action used by the solvability oracle. */
  validate: {
    secondsPerBreach: 4,
    secondsPerDownload: 2.5,
    secondsPerMisc: 1.5,
    /** Peak trace must stay below bust; the oracle's final trace must be at or below this. */
    maxTrace: 85,
    /** Missions 1..3 must additionally allow a clean exit (see cleanExitUnder). */
    cleanExitRequiredThrough: 3,
    /** Straight redraws before relaxing difficulty, then relaxed draws per level. */
    redraws: 24,
    relaxedDraws: 10,
  },

  economy: {
    /** Loot value per file indexed by the security of the node holding it (0..3). */
    cashPerFileBySecurity: [40, 90, 160, 260],
    /** Flat completion bonus by contract index / tier (1-based; clamped to array). */
    missionBonus: [0, 100, 150, 200, 260, 320, 380, 450, 520, 600, 700],
    /** Clean-exit payout multiplier on loot (PRD §7) — completed objectives only. */
    cleanMultiplier: 1.5,
    /** Bonus cash per log wiped — paid only when the objective is complete. */
    cashPerLog: 25,
    xpPerFile: 40,
    xpPerNode: 25,
    /** Clean-completion XP bonus — completed objectives only. */
    xpCleanBonus: 50,
    /** XP for delivering a payload / dossier objective (they have fewer files). */
    xpObjective: 60,
    /** Busted runs keep half XP and no cash (PRD §7). */
    bustedXpFactor: 0.5,
  },

  ranks: [
    { name: 'Script Kiddie', xp: 0 },
    { name: 'Operator', xp: 300 },
    { name: 'Breacher', xp: 800 },
    { name: 'Ghost', xp: 1600 },
    { name: 'Elite Operator', xp: 3000 },
  ],

  mission: {
    count: 10,
  },

  /** GENERATION 2 tables — frozen with the generation (see header). */
  generation: {
    v2: {
      /** Chain: loot nodes beyond the entry, by tier. */
      chainNodesByTier: [0, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6],
      /** Flagged-file objective size, by tier. */
      targetsByTier: [0, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4],
      maxSecurityByTier: [0, 1, 2, 2, 2, 3, 3, 3, 3, 3, 3],
      cipherFromTier: 4,
      /** Fork missions add a deep node past the junction from this tier. */
      deepNodeFromTier: 7,
      /** Custom/daily: fork chance, objective weights, modifier chance (tier ≥ 5). */
      forkChance: 0.75,
      objectiveWeights: { flagged: 2, dossier: 1, payload: 1 },
      modifierFromTier: 5,
      modifierChance: 0.45,
      vaultLootFiles: 2,
    },
  },

  /** The campaign plan: introductory chains, then branches, new objectives, modifiers. */
  campaign: [
    { topology: 'chain', objective: 'flagged', modifier: null },
    { topology: 'chain', objective: 'flagged', modifier: null },
    { topology: 'chain', objective: 'flagged', modifier: null },
    { topology: 'fork', objective: 'flagged', modifier: null },
    { topology: 'chain', objective: 'dossier', modifier: null },
    { topology: 'fork', objective: 'flagged', modifier: 'noisy' },
    { topology: 'fork', objective: 'payload', modifier: null },
    { topology: 'fork', objective: 'dossier', modifier: 'patrol' },
    { topology: 'fork', objective: 'payload', modifier: 'noisy' },
    { topology: 'fork', objective: 'dossier', modifier: 'patrol' },
  ] as readonly CampaignEntry[],

  tutorial: {
    seed: 'TUTORIAL-0',
    /** Any keypress inside this window is graded as the forced first-try success. */
    forcedSuccess: true,
  },

  /** Typewriter pacing for the UI (ms per character). */
  ui: {
    typeMsPerChar: 2,
    /** Lines longer than this print instantly instead of typing out. */
    instantAboveChars: 90,
  },

  /** The Broker's market: cash → power (PRD §10 upgrade list, lite edition).
   *  Price = baseCost × costMultiplier^level. Effects apply per job at runtime. */
  shop: {
    costMultiplier: 1.6,
    items: [
      { id: 'relay', name: 'burner relay', desc: '+1 proxy hop per job', maxLevel: 2, baseCost: 600 },
      { id: 'drone', name: 'decoy drone', desc: '+1 decoy per job', maxLevel: 1, baseCost: 400 },
      { id: 'overclock', name: 'overclocked NIC', desc: 'transfers 15% faster per level', maxLevel: 3, baseCost: 350 },
      { id: 'ghosting', name: 'ghost route', desc: 'idle trace creep −20% per level', maxLevel: 2, baseCost: 500 },
      { id: 'crowbar', name: 'logic crowbar', desc: 'lock fuses +8s per level', maxLevel: 2, baseCost: 450 },
      { id: 'insider', name: 'insider contact', desc: 'hints cost 40% less', maxLevel: 1, baseCost: 300 },
    ] as readonly ShopItem[],
  },

  /** PRD §17 tuning targets — the `stats` command scores actual play against these.
   *  They are playtest targets; automated tests cannot prove them. */
  stats: {
    sessionGapMs: 30 * 60 * 1000,
    targets: {
      firstBreachMs: 90_000,
      completionRate: 0.7,
      skipRate: [0.1, 0.2] as readonly [number, number],
      missionsPerSession: 2,
    },
  },
} as const;

export interface ShopItem {
  id: string;
  name: string;
  desc: string;
  maxLevel: number;
  baseCost: number;
}

export interface ModuleDef {
  id: 'burst' | 'quiet';
  name: string;
  unlockRank: string;
  transferDuration: number;
  transferTraceRate: number;
  blurb: string;
}

export interface CampaignEntry {
  topology: 'chain' | 'fork';
  objective: 'flagged' | 'dossier' | 'payload';
  modifier: 'noisy' | 'patrol' | null;
}

export type CyberGridConfig = typeof CONFIG;
