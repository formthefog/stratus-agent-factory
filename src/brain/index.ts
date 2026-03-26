/**
 * Brain Module — Brain interface, registry, and implementations
 *
 * @purpose Public API for brain implementations (IBrain, BrainRegistry, adapters)
 */

export type {
  IBrain,
  BrainConfig,
  BrainResponse,
  BrainState,
  BrainToolDefinition,
  BrainTurnEvent,
  BrainStopReason,
  BrainError,
  ToolExecutor,
  ToolResult,
  ActionRecord,
  GenerationRecord,
  StateSnapshot,
  TokenUsage,
  ProcessTurnOptions,
  StratusBrainConfig,
} from "./IBrain.js";

export {
  registerBrain,
  createBrain,
  hasBrain,
  registeredBrains,
} from "./BrainRegistry.js";

export { ReActBrainAdapter } from "./ReActBrainAdapter.js";
export type {
  RunnerDelegate,
  RunnerDelegateOptions,
  RunnerDelegateResult,
} from "./ReActBrainAdapter.js";

export {
  runWithBrain,
  runAgentWithBrain,
  resolveBrainConfig,
  extractToolDefinitions,
} from "./integration.js";
export type { BrainAgentParams, BrainRunResult } from "./integration.js";

// Tool Registry Bridge (A.3)
export type {
  OpenClawTool,
  OpenClawToolRegistration,
  ToolRegistryEntry,
  ToolAction,
} from "./tools/index.js";
export {
  openClawToolToEntry,
  entryToBrainTool,
  convertToolRegistrations,
} from "./tools/index.js";

// Memory Enhancement (A.4)
export { StateTrajectoryStore } from "./memory/index.js";
export type { StateSnapshot as TrajectorySnapshot, TrajectoryMeta } from "./memory/index.js";
export { TrajectoryMemoryBridge } from "./memory/index.js";
export type { TrajectorySummary, KeyDecision } from "./memory/index.js";
export { TrajectoryReplay } from "./memory/index.js";
export type { ReplayStep, ReplayResult } from "./memory/index.js";

// Configuration (A.5)
export {
  resolveStratusConfig,
  DEFAULT_STRATUS_CONFIG,
  ConfigValidator,
  ConfigMigrator,
} from "./config/index.js";
export type {
  StratusAgentConfig,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  OpenClawAgentConfig,
  MigrationResult,
} from "./config/index.js";
