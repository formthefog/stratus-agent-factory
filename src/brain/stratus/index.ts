/**
 * Stratus Brain Module — Sidecar RPC and lifecycle management
 *
 * @purpose Public API for Stratus sidecar communication and management
 */

// RPC wire types
export type {
  EncodeStateRequest,
  EncodeStateResponse,
  EncodeGoalRequest,
  EncodeGoalResponse,
  EncodeActionsRequest,
  EncodeActionsResponse,
  ActionEmbedding,
  ProbeRankRequest,
  ProbeRankResponse,
  RankedAction,
  PredictRequest,
  PredictResponse,
  TreeSearchRequest,
  TreeSearchResponse,
  TreeSearchStep,
  GoalProximityRequest,
  GoalProximityResponse,
  DetectFailureRequest,
  DetectFailureResponse,
  HealthResponse,
  ReloadRequest,
  ReloadResponse,
} from "./StratusRPC.js";

// RPC client
export { StratusClient, StratusClientError } from "./StratusClient.js";
export type { StratusClientConfig } from "./StratusClient.js";

// Sidecar lifecycle
export { SidecarManager } from "./SidecarManager.js";
export type {
  SidecarManagerConfig,
  SidecarStatus,
  SidecarState,
} from "./SidecarManager.js";

// State management (B.2)
export { StateAssembler } from "./StateAssembler.js";
export type {
  StateAssemblyInput,
  UserContext,
  ActionResult,
  ChannelMeta,
} from "./StateAssembler.js";

export { GoalExtractor } from "./GoalExtractor.js";
export type {
  ConversationTurn,
  ExtractedGoal,
  GoalLlmFn,
} from "./GoalExtractor.js";

export { DynamicStateTracker } from "./DynamicStateTracker.js";
export type { StepRecord } from "./DynamicStateTracker.js";

export { StateEncoderBridge } from "./StateEncoderBridge.js";
export type { EncodedState } from "./StateEncoderBridge.js";

// Action selection (B.3)
export { ActionRanker, GENERAL_PROBES } from "./ActionRanker.js";
export type { RankingInput, RankingResult, ActionRankerConfig } from "./ActionRanker.js";

export { TreeSearchOrchestrator } from "./TreeSearch.js";
export type { TreeSearchConfig, TreeSearchResult } from "./TreeSearch.js";

export { GenerationRouter } from "./GenerationRouter.js";
export type { GenerateFn, GenerationResult } from "./GenerationRouter.js";

export { ActionExecutor } from "./ActionExecutor.js";
export type { ExecutionRequest, ExecutionResult, ExecutionOptions } from "./ActionExecutor.js";

// Observation & loop control (B.4)
export { ObservationEncoderV1 } from "./ObservationEncoderV1.js";
export type { Observation, EncodedObservation, SummarizeFn } from "./ObservationEncoderV1.js";

export { GoalMonitor } from "./GoalMonitor.js";
export type { GoalMonitorConfig, StopReason, MonitorState } from "./GoalMonitor.js";

export { RecoveryManager } from "./RecoveryManager.js";
export type { RecoveryPlan, RecoveryStrategy, FailureRecord, RecoveryManagerConfig } from "./RecoveryManager.js";

// Main brain implementation (B.4.5)
export { StratusBrain } from "./StratusBrain.js";

// Observability (B.5)
export { DecisionTraceLogger } from "./DecisionTraceLogger.js";
export type { TraceEntry, TraceSession } from "./DecisionTraceLogger.js";

export { PerformanceProfiler } from "./PerformanceProfiler.js";
export type {
  ComponentName,
  LatencyBudget,
  ComponentStats,
  ProfilerSummary,
  ProfilerAlert,
} from "./PerformanceProfiler.js";
