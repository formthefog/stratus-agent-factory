/**
 * Probe Evaluator — Evaluate trained probes against test scenarios
 *
 * Evaluates action selection accuracy, ranking quality (NDCG@5),
 * recovery detection, and goal completion rate. Compares custom
 * probes against the general probe baseline.
 *
 * Backend: v4_models/probes/data.py (evaluation logic)
 *
 * @purpose Evaluate probe quality and compare against baselines
 * @spec AGENT_FACTORY_SPEC.md#e22-build-probe-evaluator
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProbeEvaluatorConfig {
  /** Sidecar URL */
  sidecarUrl: string;
}

export interface EvaluateInput {
  /** Probe ID to evaluate */
  probeId: string;
  /** Path to eval data (JSONL files) */
  evalDataDir: string;
  /** Baseline probe ID for comparison (default: "planning-v2") */
  baselineProbeId?: string;
  /** Whether to run end-to-end goal completion test */
  runGoalCompletion?: boolean;
}

export interface EvaluationResult {
  probeId: string;
  /** Action selection accuracy (did it pick the right tool?) */
  top1Accuracy: number;
  /** Top-3 accuracy */
  top3Accuracy: number;
  /** NDCG@5 ranking quality */
  ndcg5: number;
  /** Recovery detection rate (catches failures?) */
  recoveryDetection: number;
  /** Goal completion rate (end-to-end with rollouts) */
  goalCompletionRate: number | null;
  /** Per-action accuracy breakdown */
  perActionAccuracy: Record<string, number>;
  /** Comparison against baseline (if evaluated) */
  baseline: BaselineComparison | null;
}

export interface BaselineComparison {
  baselineProbeId: string;
  baselineTop1: number;
  baselineNdcg5: number;
  improvement: {
    top1Delta: number;
    ndcg5Delta: number;
    betterThanBaseline: boolean;
  };
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export class ProbeEvaluator {
  private config: ProbeEvaluatorConfig;

  constructor(config: ProbeEvaluatorConfig) {
    this.config = config;
  }

  /**
   * Evaluate a probe via the sidecar's evaluation endpoint.
   */
  async evaluate(input: EvaluateInput): Promise<EvaluationResult> {
    const payload = {
      probe_id: input.probeId,
      eval_data_dir: input.evalDataDir,
      baseline_probe_id: input.baselineProbeId ?? "planning-v2",
      run_goal_completion: input.runGoalCompletion ?? false,
    };

    const response = await fetch(`${this.config.sidecarUrl}/evaluate_probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300_000), // 5 min
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Probe evaluation failed: ${err}`);
    }

    const result = await response.json();

    const evalResult: EvaluationResult = {
      probeId: input.probeId,
      top1Accuracy: result.top1_accuracy ?? 0,
      top3Accuracy: result.top3_accuracy ?? 0,
      ndcg5: result.ndcg5 ?? 0,
      recoveryDetection: result.recovery_detection ?? 0,
      goalCompletionRate: result.goal_completion_rate ?? null,
      perActionAccuracy: result.per_action_accuracy ?? {},
      baseline: null,
    };

    // Parse baseline comparison if present
    if (result.baseline) {
      evalResult.baseline = {
        baselineProbeId: input.baselineProbeId ?? "planning-v2",
        baselineTop1: result.baseline.top1_accuracy ?? 0,
        baselineNdcg5: result.baseline.ndcg5 ?? 0,
        improvement: {
          top1Delta: evalResult.top1Accuracy - (result.baseline.top1_accuracy ?? 0),
          ndcg5Delta: evalResult.ndcg5 - (result.baseline.ndcg5 ?? 0),
          betterThanBaseline: evalResult.top1Accuracy > (result.baseline.top1_accuracy ?? 0),
        },
      };
    }

    return evalResult;
  }
}
