/**
 * Goal Proximity Monitor — Tracks progress toward goal and termination conditions
 *
 * After each step, computes cosine(state_emb, goal_emb) via the sidecar.
 * Monitors the proximity curve and triggers termination when:
 * - Goal reached (proximity > threshold)
 * - Stuck (proximity stagnant for N steps)
 * - Max steps exceeded
 * - Failure detected (via sidecar /detect_failure)
 *
 * @purpose Monitor goal proximity and determine when to stop the agent loop
 * @spec AGENT_FACTORY_SPEC.md#b43-build-goal-proximity-monitor
 */

import type { StratusClient } from "./StratusClient.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GoalMonitorConfig {
  /** Proximity threshold to consider goal reached (default: 0.85) */
  goalReachedThreshold: number;
  /** Number of steps with < stagnantDelta change to trigger stagnation (default: 3) */
  stagnantSteps: number;
  /** Minimum proximity delta to count as progress (default: 0.02) */
  stagnantDelta: number;
  /** Maximum steps before forced termination (default: 20) */
  maxSteps: number;
  /** Enable failure detection via sidecar (default: true) */
  detectFailures: boolean;
}

const DEFAULT_CONFIG: GoalMonitorConfig = {
  goalReachedThreshold: 0.85,
  stagnantSteps: 3,
  stagnantDelta: 0.02,
  maxSteps: 20,
  detectFailures: true,
};

export type StopReason =
  | "goal_reached"
  | "max_steps"
  | "stagnant"
  | "failure_detected"
  | null;

export interface MonitorState {
  currentStep: number;
  currentProximity: number;
  proximityCurve: number[];
  stopReason: StopReason;
  isStagnant: boolean;
  failureDetected: boolean;
}

// ---------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------

export class GoalMonitor {
  private config: GoalMonitorConfig;
  private client: StratusClient;
  private proximityCurve: number[] = [];
  private failureDetected = false;

  constructor(client: StratusClient, config?: Partial<GoalMonitorConfig>) {
    this.client = client;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check proximity and termination conditions after a step.
   * Returns the stop reason, or null if the loop should continue.
   */
  async check(
    stateEmbedding: number[],
    goalEmbedding: number[],
    previousStateEmbedding?: number[],
    actionTaken?: string,
    signal?: AbortSignal,
  ): Promise<StopReason> {
    // Get proximity
    const proximityResponse = await this.client.goalProximity(
      stateEmbedding,
      goalEmbedding,
      signal,
    );
    this.proximityCurve.push(proximityResponse.proximity);

    // Check goal reached
    if (proximityResponse.proximity >= this.config.goalReachedThreshold) {
      return "goal_reached";
    }

    // Check max steps
    if (this.proximityCurve.length >= this.config.maxSteps) {
      return "max_steps";
    }

    // Check stagnation
    if (this.isStagnant()) {
      return "stagnant";
    }

    // Check failure
    if (this.config.detectFailures) {
      try {
        const failureResponse = await this.client.detectFailure(
          stateEmbedding,
          previousStateEmbedding,
          actionTaken,
          signal,
        );
        if (failureResponse.is_failure) {
          this.failureDetected = true;
          return "failure_detected";
        }
      } catch {
        // Failure detection is best-effort
      }
    }

    return null;
  }

  /** Get the full monitor state. */
  getState(): MonitorState {
    return {
      currentStep: this.proximityCurve.length,
      currentProximity: this.proximityCurve[this.proximityCurve.length - 1] ?? 0,
      proximityCurve: [...this.proximityCurve],
      stopReason: null,
      isStagnant: this.isStagnant(),
      failureDetected: this.failureDetected,
    };
  }

  /** Reset for a new turn. */
  reset(): void {
    this.proximityCurve = [];
    this.failureDetected = false;
  }

  // -----------------------------------------------------------------------
  // Stagnation Detection
  // -----------------------------------------------------------------------

  private isStagnant(): boolean {
    const n = this.config.stagnantSteps;
    if (this.proximityCurve.length < n + 1) return false;

    const recent = this.proximityCurve.slice(-n);
    const baseline = this.proximityCurve[this.proximityCurve.length - n - 1];

    return recent.every(
      (p) => Math.abs(p - baseline) < this.config.stagnantDelta,
    );
  }
}
