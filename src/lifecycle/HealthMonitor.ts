/**
 * Health Monitor — Track agent performance and alert on degradation
 *
 * Monitors response latency, goal completion rate, error rate, LLM cost,
 * probe accuracy, and sidecar health. Alerts when metrics cross thresholds.
 * Integrates with the observability layer (Workstream B.5).
 *
 * @purpose Monitor agent health metrics and trigger alerts on degradation
 * @spec AGENT_FACTORY_SPEC.md#d32-build-agent-health-monitor
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthMonitorConfig {
  /** Agent ID being monitored */
  agentId: string;
  /** Sidecar URL for health checks */
  sidecarUrl: string;
  /** Gateway URL for agent health checks */
  gatewayUrl?: string;
  /** Check interval in milliseconds (default: 30000) */
  checkIntervalMs?: number;
  /** Alert thresholds */
  thresholds?: AlertThresholds;
  /** Callback for alerts */
  onAlert?: (alert: HealthAlert) => void;
  /** Callback for metric snapshots */
  onMetrics?: (snapshot: MetricSnapshot) => void;
}

export interface AlertThresholds {
  /** Max average response latency in ms (default: 5000) */
  maxLatencyMs?: number;
  /** Min goal completion rate 0-1 (default: 0.7) */
  minCompletionRate?: number;
  /** Max error rate 0-1 (default: 0.1) */
  maxErrorRate?: number;
  /** Max LLM cost per request in dollars (default: 0.50) */
  maxCostPerRequest?: number;
  /** Min probe accuracy 0-1 (default: 0.5) */
  minProbeAccuracy?: number;
  /** Max consecutive sidecar failures (default: 3) */
  maxSidecarFailures?: number;
}

export interface MetricSnapshot {
  agentId: string;
  timestamp: string;
  /** Response latency stats */
  latency: {
    avg: number;
    p50: number;
    p95: number;
    p99: number;
  };
  /** Goal completion */
  completion: {
    total: number;
    succeeded: number;
    rate: number;
  };
  /** Error tracking */
  errors: {
    total: number;
    rate: number;
    recentErrors: string[];
  };
  /** Cost tracking */
  cost: {
    totalUsd: number;
    avgPerRequest: number;
    requestCount: number;
  };
  /** Probe performance */
  probe: {
    accuracy: number;
    fallbackRate: number;
  };
  /** Sidecar status */
  sidecar: {
    healthy: boolean;
    consecutiveFailures: number;
    lastCheckMs: number;
  };
}

export interface HealthAlert {
  agentId: string;
  timestamp: string;
  severity: "warning" | "critical";
  type: AlertType;
  message: string;
  currentValue: number;
  threshold: number;
}

export type AlertType =
  | "high_latency"
  | "low_completion"
  | "high_errors"
  | "high_cost"
  | "low_probe_accuracy"
  | "sidecar_unhealthy";

// ---------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------

export class HealthMonitor {
  private config: HealthMonitorConfig;
  private thresholds: Required<AlertThresholds>;
  private timer: ReturnType<typeof setInterval> | null = null;

  // Rolling window metrics
  private latencies: number[] = [];
  private completions: { succeeded: boolean }[] = [];
  private errors: string[] = [];
  private costs: number[] = [];
  private probeHits: { correct: boolean }[] = [];
  private sidecarFailures = 0;
  private lastSidecarCheck = 0;

  // Window size
  private readonly windowSize = 100;

  constructor(config: HealthMonitorConfig) {
    this.config = config;
    this.thresholds = {
      maxLatencyMs: config.thresholds?.maxLatencyMs ?? 5000,
      minCompletionRate: config.thresholds?.minCompletionRate ?? 0.7,
      maxErrorRate: config.thresholds?.maxErrorRate ?? 0.1,
      maxCostPerRequest: config.thresholds?.maxCostPerRequest ?? 0.5,
      minProbeAccuracy: config.thresholds?.minProbeAccuracy ?? 0.5,
      maxSidecarFailures: config.thresholds?.maxSidecarFailures ?? 3,
    };
  }

  /**
   * Start periodic health checks.
   */
  start(): void {
    if (this.timer) return;

    const interval = this.config.checkIntervalMs ?? 30_000;
    this.timer = setInterval(() => this.check(), interval);

    // Run immediately
    this.check();
  }

  /**
   * Stop periodic health checks.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Record a completed request for metric tracking.
   */
  recordRequest(data: {
    latencyMs: number;
    goalReached: boolean;
    error?: string;
    costUsd: number;
    probeCorrect?: boolean;
  }): void {
    // Push to rolling windows
    this.latencies.push(data.latencyMs);
    if (this.latencies.length > this.windowSize) this.latencies.shift();

    this.completions.push({ succeeded: data.goalReached });
    if (this.completions.length > this.windowSize) this.completions.shift();

    if (data.error) {
      this.errors.push(data.error);
      if (this.errors.length > 20) this.errors.shift();
    }

    this.costs.push(data.costUsd);
    if (this.costs.length > this.windowSize) this.costs.shift();

    if (data.probeCorrect !== undefined) {
      this.probeHits.push({ correct: data.probeCorrect });
      if (this.probeHits.length > this.windowSize) this.probeHits.shift();
    }
  }

  /**
   * Get the current metric snapshot.
   */
  snapshot(): MetricSnapshot {
    const sortedLatencies = [...this.latencies].sort((a, b) => a - b);
    const completionRate = this.completions.length > 0
      ? this.completions.filter((c) => c.succeeded).length / this.completions.length
      : 1;
    const errorCount = this.completions.filter((c) => !c.succeeded).length;
    const errorRate = this.completions.length > 0
      ? errorCount / this.completions.length
      : 0;
    const totalCost = this.costs.reduce((a, b) => a + b, 0);
    const probeAccuracy = this.probeHits.length > 0
      ? this.probeHits.filter((p) => p.correct).length / this.probeHits.length
      : 1;
    const fallbackCount = this.probeHits.filter((p) => !p.correct).length;

    return {
      agentId: this.config.agentId,
      timestamp: new Date().toISOString(),
      latency: {
        avg: sortedLatencies.length > 0
          ? sortedLatencies.reduce((a, b) => a + b, 0) / sortedLatencies.length
          : 0,
        p50: this.percentile(sortedLatencies, 0.5),
        p95: this.percentile(sortedLatencies, 0.95),
        p99: this.percentile(sortedLatencies, 0.99),
      },
      completion: {
        total: this.completions.length,
        succeeded: this.completions.filter((c) => c.succeeded).length,
        rate: completionRate,
      },
      errors: {
        total: errorCount,
        rate: errorRate,
        recentErrors: this.errors.slice(-5),
      },
      cost: {
        totalUsd: totalCost,
        avgPerRequest: this.costs.length > 0 ? totalCost / this.costs.length : 0,
        requestCount: this.costs.length,
      },
      probe: {
        accuracy: probeAccuracy,
        fallbackRate: this.probeHits.length > 0
          ? fallbackCount / this.probeHits.length
          : 0,
      },
      sidecar: {
        healthy: this.sidecarFailures === 0,
        consecutiveFailures: this.sidecarFailures,
        lastCheckMs: this.lastSidecarCheck,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Health check
  // -----------------------------------------------------------------------

  private async check(): Promise<void> {
    // Check sidecar health
    await this.checkSidecar();

    // Build snapshot and check thresholds
    const snap = this.snapshot();
    this.config.onMetrics?.(snap);

    // Check thresholds
    this.checkThreshold(
      "high_latency",
      snap.latency.avg,
      this.thresholds.maxLatencyMs,
      "above",
      `Average latency ${snap.latency.avg.toFixed(0)}ms exceeds threshold ${this.thresholds.maxLatencyMs}ms`,
    );

    this.checkThreshold(
      "low_completion",
      snap.completion.rate,
      this.thresholds.minCompletionRate,
      "below",
      `Completion rate ${(snap.completion.rate * 100).toFixed(1)}% below threshold ${(this.thresholds.minCompletionRate * 100).toFixed(1)}%`,
    );

    this.checkThreshold(
      "high_errors",
      snap.errors.rate,
      this.thresholds.maxErrorRate,
      "above",
      `Error rate ${(snap.errors.rate * 100).toFixed(1)}% exceeds threshold ${(this.thresholds.maxErrorRate * 100).toFixed(1)}%`,
    );

    this.checkThreshold(
      "high_cost",
      snap.cost.avgPerRequest,
      this.thresholds.maxCostPerRequest,
      "above",
      `Average cost $${snap.cost.avgPerRequest.toFixed(3)}/request exceeds threshold $${this.thresholds.maxCostPerRequest}`,
    );

    this.checkThreshold(
      "low_probe_accuracy",
      snap.probe.accuracy,
      this.thresholds.minProbeAccuracy,
      "below",
      `Probe accuracy ${(snap.probe.accuracy * 100).toFixed(1)}% below threshold ${(this.thresholds.minProbeAccuracy * 100).toFixed(1)}%`,
    );

    if (this.sidecarFailures >= this.thresholds.maxSidecarFailures) {
      this.emitAlert({
        agentId: this.config.agentId,
        timestamp: new Date().toISOString(),
        severity: "critical",
        type: "sidecar_unhealthy",
        message: `Sidecar unreachable for ${this.sidecarFailures} consecutive checks`,
        currentValue: this.sidecarFailures,
        threshold: this.thresholds.maxSidecarFailures,
      });
    }
  }

  private async checkSidecar(): Promise<void> {
    const start = Date.now();
    try {
      const resp = await fetch(`${this.config.sidecarUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) {
        this.sidecarFailures = 0;
      } else {
        this.sidecarFailures++;
      }
    } catch {
      this.sidecarFailures++;
    }
    this.lastSidecarCheck = Date.now() - start;
  }

  private checkThreshold(
    type: AlertType,
    value: number,
    threshold: number,
    direction: "above" | "below",
    message: string,
  ): void {
    // Need minimum data before alerting
    if (this.completions.length < 10) return;

    const triggered = direction === "above"
      ? value > threshold
      : value < threshold;

    if (triggered) {
      this.emitAlert({
        agentId: this.config.agentId,
        timestamp: new Date().toISOString(),
        severity: this.isCritical(type, value, threshold) ? "critical" : "warning",
        type,
        message,
        currentValue: value,
        threshold,
      });
    }
  }

  private isCritical(type: AlertType, value: number, threshold: number): boolean {
    // Critical if 2x past threshold
    switch (type) {
      case "high_latency": return value > threshold * 2;
      case "low_completion": return value < threshold * 0.5;
      case "high_errors": return value > threshold * 2;
      case "high_cost": return value > threshold * 3;
      case "low_probe_accuracy": return value < threshold * 0.5;
      case "sidecar_unhealthy": return true;
    }
  }

  private emitAlert(alert: HealthAlert): void {
    this.config.onAlert?.(alert);
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil(p * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }
}
