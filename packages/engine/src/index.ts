/** @cybergrid/engine — deterministic, framework-agnostic game core. No DOM. */
export { CONFIG, type ShopItem, type ModuleDef, type CampaignEntry } from './config.js';
export { TELEMETRY_DEFAULT } from './types.js';
export type { Telemetry } from './types.js';
export { GameEngine, rankFor } from './game.js';
export { Rng, formatSeed } from './rng.js';
export { Vfs, walkSpecFiles, walkSpecFilesWithPaths, describeFile } from './vfs.js';
export {
  generateSequence,
  generateKnock,
  generateCipher,
  caesar,
  cipherWheel,
  instantiatePuzzle,
  gradeSequence,
  gradeKnock,
  gradeCipher,
  puzzlePrompt,
  puzzleView,
  puzzleHint,
  FAMILY_LABEL,
} from './puzzles.js';
export { generateFor, generateMission, adaptLegacySpec, contractSeed, contractCount } from './missions.js';
export { generateMissionV1, contractSeedV1, parseLegacyDraw, type LegacySpecV1 } from './gen/v1.js';
export { generateMissionV2, generateSafeTemplate, CAMPAIGN_CODENAMES } from './gen/v2.js';
export {
  simulatePerfectRun,
  playOracle,
  validateSpec,
  routesFor,
  passes,
  drawSchedule,
  buildValidatedMission,
  MissionUnavailableError,
  type OracleOptions,
  type SimResult,
  type Route,
} from './validate.js';
export {
  SHARE_FORMAT,
  MAX_SEED_LENGTH,
  encodeShareCode,
  decodeShareCode,
  descriptorProblem,
  campaignDescriptor,
  customDescriptor,
  dailyDescriptor,
  tutorialDescriptor,
  dailyDateOf,
  descriptorKey,
  describeDescriptor,
  planFor,
  utcDate,
  type DecodeResult,
} from './identity.js';
export { graphOf, neighbors, linked, nodeById, distances, shortestPath, frontier, layoutOf } from './graph.js';
export { objectiveDone, objectiveCount, objectiveLabel, objectiveProgressText, objectiveRoleOf, objectiveNodeIds } from './objectives.js';
export {
  moduleDef,
  moduleUnlocked,
  unlocksBetween,
  profileLoadout,
  starterLoadout,
  effectiveFor,
  downloadTraceFor,
  loadoutLabel,
  loadoutKey,
  rankIndexForXp,
  type Effective,
} from './equipment.js';
export { scoreRun, exitQualityFor, bonusFactor, missionBonusFor, OUTCOME_LABEL, recordKey, compareRecords, recordRun, emptyRecords } from './results.js';
export { migrateSave, sessionProblem, defaultSave, defaultProfile, SETTINGS_DEFAULT, SAVE_VERSION, convertLegacySession, type MigrationReport } from './persistence.js';
export { tutorialMission, TUTORIAL_STEPS } from './tutorial.js';
export { COMMANDS, lookupCommand, commandsForMode, didYouMean, manPage } from './commands.js';
export {
  shopItem,
  upgradeLevel,
  upgradeCost,
  proxyHopsFor,
  decoysFor,
  transferSecondsFor,
  idleRateFactor,
  fuseBonusFor,
  hintCostFor,
} from './shop.js';
export { runSimulation, formatSimulationReport, type SimulationReport, type ScenarioResult } from './simulate.js';
export type * from './types.js';
export type { StorageAdapter, GameEngineOptions } from './game.js';
