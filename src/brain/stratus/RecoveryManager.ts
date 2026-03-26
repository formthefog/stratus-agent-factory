/**
 * Recovery & Backtracking Manager
 *
 * Handles failure detection and recovery strategies:
 * 1. When failure detected: roll back to last good state, exclude failed action
 * 2. When stagnant: switch probes, attempt deeper tree search, LLM recovery plan
 *
 * @purpose Failure recovery and backtracking for the agent loop
 * @spec AGENT_FACTORY_SPEC.md#b44-build-recovery-backtracking-system
 */

import type { ActionRanker } from "./ActionRanker.js";
import { GENERAL_PROBES } from "./ActionRanker.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StateSnapshot {
  embedding: number[];
  stepNumber: number;
  goalProximity: number;
  timestamp: string;
}

export interface FailureRecord {
  /** Step where failure occurred */
  step: number;
  /** Action that caused failure */
  failedAction: string;
  /** State before the failure */
  preFailureState: StateSnapshot;
  /** Failure type from detector */
  failureType?: string;
}

export type RecoveryStrategy =
  | "rollback"        // Roll back to last good state
  | "probe_switch"    // Switch to different probe
  | "deep_search"     // Attempt deeper tree search
  | "llm_recovery"    // Generate recovery plan via LLM
  | "give_up";        // Max recovery attempts exceeded

export interface RecoveryPlan {
  strategy: RecoveryStrategy;
  /** State to recover to (for rollback) */
  recoveryState?: StateSnapshot;
  /** Actions to exclude from future ranking */
  excludedActions: string[];
  /** Probe to use (for probe_switch) */
  probeId?: string;
  /** LLM-generated recovery instructions (for llm_recovery) */
  instructions?: string;
}

export interface RecoveryManagerConfig {
  /** Max rollback depth (default: 3) */
  maxRollbackDepth: number;
  /** Max total recovery attempts per turn (default: 5) */
  maxRecoveryAttempts: number;
  /** Probe sequence for stagnation recovery */
  probeSequence: string[];
}

const DEFAULT_CONFIG: RecoveryManagerConfig = {
  maxRollbackDepth: 3,
  maxRecoveryAttempts: 5,
  probeSequence: [
    GENERAL_PROBES.RECOVERY,
    GENERAL_PROBES.PLANNING,
    GENERAL_PROBES.COORDINATION,
  ],
};

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class RecoveryManager {
  private config: RecoveryManagerConfig;
  private stateHistory: StateSnapshot[] = [];
  private failures: FailureRecord[] = [];
  private excludedActions = new Set<string>();
  private recoveryAttempts = 0;
  private currentProbeIndex = 0;

  constructor(config?: Partial<RecoveryManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Record a state snapshot (call after each successful step). */
  recordState(snapshot: StateSnapshot): void {
    this.stateHistory.push(snapshot);
  }

  /** Get the list of actions that should be excluded from ranking. */
  getExcludedActions(): string[] {
    return Array.from(this.excludedActions);
  }

  /**
   * Handle a detected failure. Returns a recovery plan.
   */
  handleFailure(
    failedAction: string,
    currentState: StateSnapshot,
    failureType?: string,
  ): RecoveryPlan {
    this.recoveryAttempts++;

    // Record the failure
    const preFailureState = this.stateHistory.length > 0
      ? this.stateHistory[this.stateHistory.length - 1]
      : currentState;

    this.failures.push({
      step: currentState.stepNumber,
      failedAction,
      preFailureState,
      failureType,
    });

    // Exclude the failed action
    this.excludedActions.add(failedAction);

    // Check if we've exceeded max attempts
    if (this.recoveryAttempts > this.config.maxRecoveryAttempts) {
      return {
        strategy: "give_up",
        excludedActions: this.getExcludedActions(),
      };
    }

    // Rollback to last good state
    const rollbackState = this.findRollbackState();
    if (rollbackState) {
      return {
        strategy: "rollback",
        recoveryState: rollbackState,
        excludedActions: this.getExcludedActions(),
      };
    }

    // No good state to roll back to — try probe switch
    return this.buildProbeSwitchPlan();
  }

  /**
   * Handle stagnation (proximity not improving). Returns a recovery plan.
   */
  handleStagnation(): RecoveryPlan {
    this.recoveryAttempts++;

    if (this.recoveryAttempts > this.config.maxRecoveryAttempts) {
      return {
        strategy: "give_up",
        excludedActions: this.getExcludedActions(),
      };
    }

    // First attempt: switch probes
    if (this.currentProbeIndex < this.config.probeSequence.length) {
      return this.buildProbeSwitchPlan();
    }

    // Probe sequence exhausted: try deep search
    if (this.recoveryAttempts <= this.config.maxRecoveryAttempts - 1) {
      return {
        strategy: "deep_search",
        excludedActions: this.getExcludedActions(),
      };
    }

    // Last resort: LLM recovery
    return {
      strategy: "llm_recovery",
      excludedActions: this.getExcludedActions(),
    };
  }

  /** Reset for a new turn. */
  reset(): void {
    this.stateHistory = [];
    this.failures = [];
    this.excludedActions.clear();
    this.recoveryAttempts = 0;
    this.currentProbeIndex = 0;
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private findRollbackState(): StateSnapshot | undefined {
    // Find the most recent state that was "good" (had improving proximity)
    for (let i = this.stateHistory.length - 1; i >= 0; i--) {
      const depth = this.stateHistory.length - 1 - i;
      if (depth >= this.config.maxRollbackDepth) break;

      const state = this.stateHistory[i];
      // A "good" state is one that was making progress
      if (i > 0 && state.goalProximity > this.stateHistory[i - 1].goalProximity) {
        return state;
      }
    }
    return undefined;
  }

  private buildProbeSwitchPlan(): RecoveryPlan {
    const probeId = this.config.probeSequence[this.currentProbeIndex]
      ?? GENERAL_PROBES.PLANNING;
    this.currentProbeIndex++;

    return {
      strategy: "probe_switch",
      excludedActions: this.getExcludedActions(),
      probeId,
    };
  }
}
