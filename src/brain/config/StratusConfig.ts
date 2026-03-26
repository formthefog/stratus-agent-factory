/**
 * Stratus Agent Config — Type definitions and defaults
 *
 * Extends OpenClaw's openclaw.json with Stratus-specific configuration.
 * This is the single source of truth for all Stratus config shapes.
 *
 * @purpose Stratus configuration types and default values
 * @spec AGENT_FACTORY_SPEC.md#a51-design-stratus-agent-config-format
 */

// ---------------------------------------------------------------------------
// Config Types
// ---------------------------------------------------------------------------

/** The Stratus section of an OpenClaw agent config. */
export interface StratusAgentConfig {
  /** Path to model checkpoint (default: ~/.stratus/models/v6-latest.pt) */
  modelPath: string;
  /** Probe ID to use (default: "planning-v2") */
  probe: string;
  /** Path to custom probe weights (null for built-in probes) */
  customProbePath?: string;
  /** LLM provider for generation calls (default: "anthropic") */
  llmProvider: string;
  /** LLM model for generation calls */
  llmModel: string;
  /** Tree search configuration */
  treeSearch: TreeSearchConfig;
  /** Goal proximity threshold to consider goal reached (default: 0.85) */
  goalProximityThreshold: number;
  /** Max steps per turn (default: 20) */
  maxSteps: number;
  /** Observation encoder mode (default: "llm_bridge") */
  observationEncoder: "adapter" | "llm_bridge" | "direct";
  /** Enable tool embedding cache (default: true) */
  toolEmbeddingCache: boolean;
  /** Sidecar configuration */
  sidecar: SidecarConfig;
  /** Recovery configuration */
  recovery: RecoveryConfig;
  /** Observability configuration */
  observability: ObservabilityConfig;
}

export interface TreeSearchConfig {
  /** Enable tree search for ambiguous rankings (default: true) */
  enabled: boolean;
  /** Max search depth (default: 3) */
  maxDepth: number;
  /** Beam width (default: 5) */
  beamWidth: number;
  /** Score gap below which top-2 trigger search (default: 0.15) */
  ambiguityThreshold: number;
  /** Wall time budget in ms (default: 500) */
  timeBudgetMs: number;
}

export interface SidecarConfig {
  /** Sidecar host (default: "127.0.0.1") */
  host: string;
  /** Sidecar port (default: 8100) */
  port: number;
  /** Auto-start sidecar if not running (default: true) */
  autoStart: boolean;
  /** Request timeout in ms (default: 30000) */
  timeoutMs: number;
}

export interface RecoveryConfig {
  /** Max rollback depth (default: 3) */
  maxRollbackDepth: number;
  /** Max recovery attempts per turn (default: 5) */
  maxRecoveryAttempts: number;
  /** Enable failure detection via sidecar (default: true) */
  detectFailures: boolean;
}

export interface ObservabilityConfig {
  /** Enable decision trace logging (default: true) */
  traceEnabled: boolean;
  /** Trace output directory (default: ".stratus/traces") */
  traceDir: string;
  /** Enable performance profiling (default: true) */
  profileEnabled: boolean;
  /** Enable trajectory storage (default: true) */
  trajectoryEnabled: boolean;
  /** Trajectory storage directory (default: ".stratus/trajectories") */
  trajectoryDir: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_TREE_SEARCH: TreeSearchConfig = {
  enabled: true,
  maxDepth: 3,
  beamWidth: 5,
  ambiguityThreshold: 0.15,
  timeBudgetMs: 500,
};

export const DEFAULT_SIDECAR: SidecarConfig = {
  host: "127.0.0.1",
  port: 8100,
  autoStart: true,
  timeoutMs: 30_000,
};

export const DEFAULT_RECOVERY: RecoveryConfig = {
  maxRollbackDepth: 3,
  maxRecoveryAttempts: 5,
  detectFailures: true,
};

export const DEFAULT_OBSERVABILITY: ObservabilityConfig = {
  traceEnabled: true,
  traceDir: ".stratus/traces",
  profileEnabled: true,
  trajectoryEnabled: true,
  trajectoryDir: ".stratus/trajectories",
};

export const DEFAULT_STRATUS_CONFIG: StratusAgentConfig = {
  modelPath: "~/.stratus/models/v6-latest.pt",
  probe: "planning-v2",
  llmProvider: "anthropic",
  llmModel: "claude-sonnet-4-5-20250514",
  treeSearch: DEFAULT_TREE_SEARCH,
  goalProximityThreshold: 0.85,
  maxSteps: 20,
  observationEncoder: "llm_bridge",
  toolEmbeddingCache: true,
  sidecar: DEFAULT_SIDECAR,
  recovery: DEFAULT_RECOVERY,
  observability: DEFAULT_OBSERVABILITY,
};

/**
 * Merge partial config with defaults.
 */
export function resolveStratusConfig(
  partial?: Partial<StratusAgentConfig>,
): StratusAgentConfig {
  if (!partial) return { ...DEFAULT_STRATUS_CONFIG };

  return {
    ...DEFAULT_STRATUS_CONFIG,
    ...partial,
    treeSearch: { ...DEFAULT_TREE_SEARCH, ...partial.treeSearch },
    sidecar: { ...DEFAULT_SIDECAR, ...partial.sidecar },
    recovery: { ...DEFAULT_RECOVERY, ...partial.recovery },
    observability: { ...DEFAULT_OBSERVABILITY, ...partial.observability },
  };
}
