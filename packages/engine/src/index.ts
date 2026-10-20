/** @cybergrid/engine — deterministic, framework-agnostic game core. No DOM. */
export { CONFIG, type ShopItem } from './config.js';
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
  instantiatePuzzle,
  gradeSequence,
  gradeKnock,
  gradeCipher,
  puzzlePrompt,
  puzzleView,
  puzzleHint,
} from './puzzles.js';
export { generateMission, contractSeed, contractCount } from './missions.js';
export { simulatePerfectRun, buildValidatedMission } from './validate.js';
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
export type {
  Cls,
  Sfx,
  PrintStyle,
  EngineEvent,
  GameMode,
  MissionOutcome,
  MissionResult,
  FileTag,
  FileSpec,
  DirSpec,
  PuzzleFamily,
  PuzzleAnswer,
  PuzzleState,
  PuzzleView,
  MissionNodeSpec,
  MissionSpec,
  NodeView,
  TargetView,
  PuzzleSnapshot,
  Snapshot,
  SaveBlob,
  SessionSave,
  TraceCause,
} from './types.js';
export type { StorageAdapter, GameEngineOptions } from './game.js';
