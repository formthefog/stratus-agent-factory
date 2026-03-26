/**
 * Probe Performance Tracker — Monitor deployed probe accuracy over time
 *
 * This is new functionality — no Python backend equivalent.
 * Tracks probe accuracy in production, detects degradation and
 * distribution shift, and triggers retraining recommendations.
 *
 * @purpose Monitor deployed probe accuracy and detect when retraining is needed
 * @spec AGENT_FACTORY_SPEC.md#e31-build-probe-performance-tracker
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PerformanceTrackerConfig {
  /** Probe ID being tracked */
  probeId: string;
  /** Agent ID */
  agentId: string;
  /** Accuracy threshold below which retraining is recommended */
  retrainThreshold: number;
  /** Window size for rolling accuracy (default: 200) */
  windowSize?: number;
  /** Callback when retraining is recommended */
  onRetrainRecommended?: (report: DegradationReport) => void;
}

export interface ProbeObservation {
  /** Probe predicted this action */
  predictedAction: string;
  /** Action actually taken (may differ if LLM overrode probe) */
  actualAction: string;
  /** Whether the action led to progress */
  wasSuccessful: boolean;
  /** Domain context */
  domain: string;
  /** Timestamp */
  timestamp: string;
}

export interface PerformanceSnapshot {
  probeId: string;
  agentId: string;
  /** Rolling accuracy over window */
  accuracy: number;
  /** Accuracy trend (positive = improving, negative = degrading) */
  trend: number;
  /** Total observations */
  totalObservations: number;
  /** Per-action accuracy */
  perActionAccuracy: Record<string, { correct: number; total: number; rate: number }>;
  /** New actions seen that weren't in training */
  unseenActions: string[];
  /** Whether retraining is recommended */
  retrainRecommended: boolean;
  /** Reasons for recommendation */
  reasons: string[];
}

export interface DegradationReport {
  probeId: string;
  agentId: string;
  currentAccuracy: number;
  threshold: number;
  trend: number;
  unseenActions: string[];
  reasons: string[];
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

export class ProbePerformanceTracker {
  private config: PerformanceTrackerConfig;
  private windowSize: number;

  // Rolling window
  private observations: ProbeObservation[] = [];
  private knownActions = new Set<string>();
  private unseenActions = new Set<string>();

  // Historical accuracy for trend detection
  private accuracyHistory: number[] = [];
  private readonly historySize = 20; // 20 snapshots for trend

  constructor(config: PerformanceTrackerConfig) {
    this.config = config;
    this.windowSize = config.windowSize ?? 200;
  }

  /**
   * Register the actions this probe was trained on.
   * Used to detect distribution shift (new actions appearing in production).
   */
  setKnownActions(actions: string[]): void {
    this.knownActions = new Set(actions);
  }

  /**
   * Record a probe observation from production.
   */
  observe(obs: ProbeObservation): void {
    this.observations.push(obs);
    if (this.observations.length > this.windowSize) {
      this.observations.shift();
    }

    // Track unseen actions
    if (this.knownActions.size > 0 && !this.knownActions.has(obs.actualAction)) {
      this.unseenActions.add(obs.actualAction);
    }

    // Periodically check for degradation (every windowSize/4 observations)
    if (this.observations.length % Math.max(1, Math.floor(this.windowSize / 4)) === 0) {
      const snap = this.snapshot();
      if (snap.retrainRecommended) {
        this.config.onRetrainRecommended?.({
          probeId: this.config.probeId,
          agentId: this.config.agentId,
          currentAccuracy: snap.accuracy,
          threshold: this.config.retrainThreshold,
          trend: snap.trend,
          unseenActions: snap.unseenActions,
          reasons: snap.reasons,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  /**
   * Get current performance snapshot.
   */
  snapshot(): PerformanceSnapshot {
    const correct = this.observations.filter(
      (o) => o.predictedAction === o.actualAction,
    ).length;
    const accuracy = this.observations.length > 0
      ? correct / this.observations.length
      : 1;

    // Update history
    this.accuracyHistory.push(accuracy);
    if (this.accuracyHistory.length > this.historySize) {
      this.accuracyHistory.shift();
    }

    // Compute trend (linear regression slope)
    const trend = this.computeTrend();

    // Per-action breakdown
    const perAction: Record<string, { correct: number; total: number; rate: number }> = {};
    for (const obs of this.observations) {
      if (!perAction[obs.actualAction]) {
        perAction[obs.actualAction] = { correct: 0, total: 0, rate: 0 };
      }
      perAction[obs.actualAction].total++;
      if (obs.predictedAction === obs.actualAction) {
        perAction[obs.actualAction].correct++;
      }
    }
    for (const action of Object.keys(perAction)) {
      perAction[action].rate = perAction[action].correct / perAction[action].total;
    }

    // Determine if retraining is recommended
    const reasons: string[] = [];
    let retrainRecommended = false;

    if (this.observations.length >= this.windowSize / 2) {
      if (accuracy < this.config.retrainThreshold) {
        reasons.push(
          `Accuracy ${(accuracy * 100).toFixed(1)}% below threshold ${(this.config.retrainThreshold * 100).toFixed(1)}%`,
        );
        retrainRecommended = true;
      }

      if (trend < -0.02) {
        reasons.push(`Accuracy trending down (slope: ${trend.toFixed(4)})`);
        retrainRecommended = true;
      }

      if (this.unseenActions.size > 2) {
        reasons.push(
          `${this.unseenActions.size} new actions in production not in training: ${[...this.unseenActions].join(", ")}`,
        );
        retrainRecommended = true;
      }

      // Check for individual action collapse
      for (const [action, stats] of Object.entries(perAction)) {
        if (stats.total >= 10 && stats.rate < 0.3) {
          reasons.push(`Action "${action}" accuracy collapsed to ${(stats.rate * 100).toFixed(1)}%`);
          retrainRecommended = true;
        }
      }
    }

    return {
      probeId: this.config.probeId,
      agentId: this.config.agentId,
      accuracy,
      trend,
      totalObservations: this.observations.length,
      perActionAccuracy: perAction,
      unseenActions: [...this.unseenActions],
      retrainRecommended,
      reasons,
    };
  }

  /**
   * Reset tracking (after retrain/deploy of new probe).
   */
  reset(): void {
    this.observations = [];
    this.unseenActions.clear();
    this.accuracyHistory = [];
  }

  // -----------------------------------------------------------------------
  // Trend
  // -----------------------------------------------------------------------

  private computeTrend(): number {
    const n = this.accuracyHistory.length;
    if (n < 3) return 0;

    // Simple linear regression slope
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += this.accuracyHistory[i];
      sumXY += i * this.accuracyHistory[i];
      sumX2 += i * i;
    }

    const denom = n * sumX2 - sumX * sumX;
    if (denom === 0) return 0;

    return (n * sumXY - sumX * sumY) / denom;
  }
}
