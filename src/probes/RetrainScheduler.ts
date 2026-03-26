/**
 * Retrain Scheduler — TS wrapper over Python RetrainScheduler
 *
 * Wraps v4_models/probes/retrain.py. Monitors trace counts and triggers
 * retrains when thresholds are met. Supports the three-phase customer
 * funnel: cold_start → warm_up → continuous.
 *
 * Backend: v4_models/probes/retrain.py (RetrainScheduler)
 *
 * @purpose Automated probe retraining when performance degrades or new data arrives
 * @spec AGENT_FACTORY_SPEC.md#e32-build-automated-retraining-scheduler
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetrainSchedulerConfig {
  /** Sidecar URL */
  sidecarUrl: string;
  /** Agent ID */
  agentId: string;
  /** Probe ID to retrain */
  probeId: string;
  /** Trace data directory */
  traceDir: string;
  /** Check interval in milliseconds (default: 3600000 = 1 hour) */
  checkIntervalMs?: number;
  /** Callback when retrain completes */
  onRetrainComplete?: (result: RetrainResult) => void;
  /** Callback when retrain is triggered */
  onRetrainTriggered?: (reason: string) => void;
}

export interface RetrainResult {
  success: boolean;
  probeId: string;
  phase: CustomerPhase;
  newTraceCount: number;
  metrics: {
    beforeAccuracy: number;
    afterAccuracy: number;
    improvement: number;
    promoted: boolean;
  };
  error?: string;
}

export type CustomerPhase = "cold_start" | "warm_up" | "continuous";

export interface SchedulerStatus {
  probeId: string;
  agentId: string;
  phase: CustomerPhase;
  totalTraces: number;
  tracesUntilRetrain: number;
  lastRetrainAt: string | null;
  running: boolean;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class RetrainScheduler {
  private config: RetrainSchedulerConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private phase: CustomerPhase = "cold_start";
  private lastRetrainAt: string | null = null;
  private retrainCount = 0;

  // Phase thresholds (matching retrain.py)
  private static readonly PHASE_THRESHOLDS = {
    cold_start: { retrainAt: 500, advanceTo: "warm_up" as const },
    warm_up: { retrainAt: 500, advanceAt: 2000, advanceTo: "continuous" as const },
    continuous: { retrainAt: 500 },
  };

  constructor(config: RetrainSchedulerConfig) {
    this.config = config;
  }

  /**
   * Start the automated retrain scheduler.
   */
  start(): void {
    if (this.timer) return;

    const interval = this.config.checkIntervalMs ?? 3_600_000;
    this.timer = setInterval(() => this.check(), interval);

    // Run immediately
    this.check();
  }

  /**
   * Stop the scheduler.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Manually trigger a retrain check.
   */
  async check(): Promise<void> {
    try {
      const status = await this.getTraceCount();
      const threshold = RetrainScheduler.PHASE_THRESHOLDS[this.phase];
      const tracesNeeded = threshold.retrainAt;

      if (status.newTraces >= tracesNeeded) {
        this.config.onRetrainTriggered?.(
          `${status.newTraces} new traces (threshold: ${tracesNeeded}) in phase ${this.phase}`,
        );
        await this.retrain();
      }
    } catch {
      // Check failed — retry next interval
    }
  }

  /**
   * Force a retrain regardless of trace count.
   */
  async forceRetrain(): Promise<RetrainResult> {
    return this.retrain();
  }

  /**
   * Get current scheduler status.
   */
  async status(): Promise<SchedulerStatus> {
    const traceCount = await this.getTraceCount();
    const threshold = RetrainScheduler.PHASE_THRESHOLDS[this.phase];

    return {
      probeId: this.config.probeId,
      agentId: this.config.agentId,
      phase: this.phase,
      totalTraces: traceCount.total,
      tracesUntilRetrain: Math.max(0, threshold.retrainAt - traceCount.newTraces),
      lastRetrainAt: this.lastRetrainAt,
      running: this.timer !== null,
    };
  }

  // -----------------------------------------------------------------------
  // Retrain
  // -----------------------------------------------------------------------

  private async retrain(): Promise<RetrainResult> {
    const payload = {
      probe_id: this.config.probeId,
      agent_id: this.config.agentId,
      trace_dir: this.config.traceDir,
      phase: this.phase,
    };

    try {
      const response = await fetch(
        `${this.config.sidecarUrl}/probes/retrain`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(600_000), // 10 min
        },
      );

      if (!response.ok) {
        const err = await response.text();
        const result: RetrainResult = {
          success: false,
          probeId: this.config.probeId,
          phase: this.phase,
          newTraceCount: 0,
          metrics: { beforeAccuracy: 0, afterAccuracy: 0, improvement: 0, promoted: false },
          error: err,
        };
        this.config.onRetrainComplete?.(result);
        return result;
      }

      const data = await response.json();

      const result: RetrainResult = {
        success: data.success ?? true,
        probeId: this.config.probeId,
        phase: this.phase,
        newTraceCount: data.new_trace_count ?? 0,
        metrics: {
          beforeAccuracy: data.before_accuracy ?? 0,
          afterAccuracy: data.after_accuracy ?? 0,
          improvement: data.improvement ?? 0,
          promoted: data.promoted ?? false,
        },
      };

      this.lastRetrainAt = new Date().toISOString();
      this.retrainCount++;

      // Advance phase if threshold met
      this.advancePhaseIfReady(data.total_traces ?? 0);

      this.config.onRetrainComplete?.(result);
      return result;
    } catch (err) {
      const result: RetrainResult = {
        success: false,
        probeId: this.config.probeId,
        phase: this.phase,
        newTraceCount: 0,
        metrics: { beforeAccuracy: 0, afterAccuracy: 0, improvement: 0, promoted: false },
        error: err instanceof Error ? err.message : String(err),
      };
      this.config.onRetrainComplete?.(result);
      return result;
    }
  }

  // -----------------------------------------------------------------------
  // Phase management
  // -----------------------------------------------------------------------

  private advancePhaseIfReady(totalTraces: number): void {
    const threshold = RetrainScheduler.PHASE_THRESHOLDS[this.phase];

    if ("advanceAt" in threshold && "advanceTo" in threshold) {
      if (totalTraces >= (threshold as any).advanceAt) {
        this.phase = (threshold as any).advanceTo;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Trace counting
  // -----------------------------------------------------------------------

  private async getTraceCount(): Promise<{ total: number; newTraces: number }> {
    try {
      const response = await fetch(
        `${this.config.sidecarUrl}/probes/trace_count?agent_id=${this.config.agentId}`,
      );

      if (!response.ok) return { total: 0, newTraces: 0 };

      const data = await response.json();
      return {
        total: data.total ?? 0,
        newTraces: data.new_since_last_retrain ?? data.total ?? 0,
      };
    } catch {
      return { total: 0, newTraces: 0 };
    }
  }
}
