/**
 * CyberGrid — single source of truth for every tunable constant.
 * Difficulty tuning must never require touching game logic: change numbers here only.
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
    /** Seconds between watchdog patrols (moves to an adjacent-ish node). */
    watchdogMoveSeconds: 22,
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
    /** Common ports the knock locks draw from. */
    knockPortPool: [22, 53, 80, 143, 443, 587, 1521, 3306, 3389, 8080, 8443, 9090],
  },

  download: {
    /** Seconds per file transfer (all files are small; drama comes from the meter). */
    secondsPerFile: 1.6,
  },

  /** Simulated "operator think time" per action used by the perfect-run validator. */
  validate: {
    secondsPerBreach: 4,
    secondsPerDownload: 2.5,
    secondsPerMisc: 1.5,
    /** Perfect run must finish at or below this trace to count as "completable with margin". */
    maxTrace: 85,
    /** Missions 1..3 must additionally allow a clean exit (see cleanExitUnder) with tools. */
    cleanExitRequiredThrough: 3,
  },

  economy: {
    /** Loot value per file indexed by the security of the node holding it (0..3). */
    cashPerFileBySecurity: [40, 90, 160, 260],
    /** Flat completion bonus by contract index (1-based; index clamped to array). */
    missionBonus: [0, 100, 150, 200, 260, 320, 380, 450, 520, 600, 700],
    /** Clean-exit payout multiplier (PRD §7). */
    cleanMultiplier: 1.5,
    /** Bonus cash per log wiped. */
    cashPerLog: 25,
    xpPerFile: 40,
    xpPerNode: 25,
    xpCleanBonus: 50,
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
    /** Loot nodes per contract (beyond the entry node), by contract index. */
    nodesByIndex: [0, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6],
    /** Required target files ("steal N files") by contract index. */
    targetsByIndex: [0, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4],
    /** Highest security level reachable per contract index (generator jitter stays ≤ this). */
    maxSecurityByIndex: [0, 1, 2, 2, 2, 3, 3, 3, 3, 3, 3],
    /** Cipher locks debut on this contract index (earlier contracts use sequences + knocks). */
    cipherFromIndex: 4,
  },

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

  /** PRD §17 tuning targets — the `stats` command scores actual play against these. */
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

export type CyberGridConfig = typeof CONFIG;
