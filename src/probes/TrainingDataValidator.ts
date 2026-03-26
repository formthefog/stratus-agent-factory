/**
 * Training Data Validator — Ensure training data quality before probe training
 *
 * Wraps the validation logic from v4_training/synthetic/audit_training_data.py.
 * Checks volume, action coverage, goal diversity, and trajectory quality.
 *
 * Backend: v4_training/synthetic/audit_training_data.py
 *
 * @purpose Validate training data sufficiency and quality for probe training
 * @spec AGENT_FACTORY_SPEC.md#e13-build-training-data-validator
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidationConfig {
  /** Minimum trajectories needed (default: 500) */
  minTrajectories?: number;
  /** Minimum appearances per tool (default: 10) */
  minActionCoverage?: number;
  /** Minimum distinct goal types (default: 5) */
  minGoalDiversity?: number;
  /** Minimum fraction of trajectories that reach goal (default: 0.5) */
  minSuccessRate?: number;
}

export interface ValidationResult {
  valid: boolean;
  checks: ValidationCheck[];
  summary: {
    totalTrajectories: number;
    uniqueActions: number;
    uniqueGoals: number;
    successRate: number;
    avgLength: number;
    uncoveredTools: string[];
  };
}

export interface ValidationCheck {
  name: string;
  passed: boolean;
  message: string;
  actual: number;
  required: number;
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export class TrainingDataValidator {
  private config: Required<ValidationConfig>;

  constructor(config: ValidationConfig = {}) {
    this.config = {
      minTrajectories: config.minTrajectories ?? 500,
      minActionCoverage: config.minActionCoverage ?? 10,
      minGoalDiversity: config.minGoalDiversity ?? 5,
      minSuccessRate: config.minSuccessRate ?? 0.5,
    };
  }

  /**
   * Validate training data from a directory of JSONL files.
   * Files match the trace_pipeline.py output format.
   */
  validate(dataDir: string, expectedTools?: string[]): ValidationResult {
    const records = this.loadRecords(dataDir);
    const checks: ValidationCheck[] = [];

    // Count trajectories
    const totalTrajectories = records.length;
    checks.push({
      name: "sufficient_volume",
      passed: totalTrajectories >= this.config.minTrajectories,
      message: totalTrajectories >= this.config.minTrajectories
        ? `${totalTrajectories} trajectories (need ${this.config.minTrajectories})`
        : `Only ${totalTrajectories} trajectories (need ${this.config.minTrajectories})`,
      actual: totalTrajectories,
      required: this.config.minTrajectories,
    });

    // Action coverage
    const actionCounts = new Map<string, number>();
    for (const record of records) {
      const action = record.action?.type ?? "unknown";
      actionCounts.set(action, (actionCounts.get(action) ?? 0) + 1);
    }

    const uncoveredTools: string[] = [];
    if (expectedTools) {
      for (const tool of expectedTools) {
        const count = actionCounts.get(tool) ?? 0;
        if (count < this.config.minActionCoverage) {
          uncoveredTools.push(tool);
        }
      }
    }

    const minCovered = expectedTools
      ? expectedTools.length - uncoveredTools.length
      : actionCounts.size;
    const totalExpected = expectedTools?.length ?? actionCounts.size;

    checks.push({
      name: "action_coverage",
      passed: uncoveredTools.length === 0,
      message: uncoveredTools.length === 0
        ? `All ${totalExpected} tools have ≥${this.config.minActionCoverage} appearances`
        : `${uncoveredTools.length} tools below ${this.config.minActionCoverage} appearances: ${uncoveredTools.join(", ")}`,
      actual: minCovered,
      required: totalExpected,
    });

    // Goal diversity
    const goals = new Set<string>();
    for (const record of records) {
      const goal = record.state?.static_context?.goal;
      if (goal) goals.add(goal);
    }

    checks.push({
      name: "goal_diversity",
      passed: goals.size >= this.config.minGoalDiversity,
      message: goals.size >= this.config.minGoalDiversity
        ? `${goals.size} distinct goals (need ${this.config.minGoalDiversity})`
        : `Only ${goals.size} distinct goals (need ${this.config.minGoalDiversity})`,
      actual: goals.size,
      required: this.config.minGoalDiversity,
    });

    // Success rate (trajectories that reach goal)
    const successCount = records.filter(
      (r) => r.state?.metadata?.goal_reached === true,
    ).length;
    const successRate = totalTrajectories > 0
      ? successCount / totalTrajectories
      : 0;

    checks.push({
      name: "trajectory_quality",
      passed: successRate >= this.config.minSuccessRate,
      message: successRate >= this.config.minSuccessRate
        ? `${(successRate * 100).toFixed(1)}% success rate (need ${(this.config.minSuccessRate * 100).toFixed(1)}%)`
        : `Only ${(successRate * 100).toFixed(1)}% success rate (need ${(this.config.minSuccessRate * 100).toFixed(1)}%)`,
      actual: successRate,
      required: this.config.minSuccessRate,
    });

    // Average trajectory length (from metadata if available)
    const lengths: number[] = [];
    for (const record of records) {
      const len = record.state?.metadata?.episode_length;
      if (typeof len === "number") lengths.push(len);
    }
    const avgLength = lengths.length > 0
      ? lengths.reduce((a, b) => a + b, 0) / lengths.length
      : 0;

    return {
      valid: checks.every((c) => c.passed),
      checks,
      summary: {
        totalTrajectories,
        uniqueActions: actionCounts.size,
        uniqueGoals: goals.size,
        successRate,
        avgLength,
        uncoveredTools,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Loading
  // -----------------------------------------------------------------------

  private loadRecords(dataDir: string): Record<string, any>[] {
    if (!existsSync(dataDir)) return [];

    const records: Record<string, any>[] = [];
    const files = readdirSync(dataDir).filter(
      (f) => f.endsWith(".jsonl") || f.endsWith(".jsonl.gz"),
    );

    for (const file of files) {
      const filePath = join(dataDir, file);

      if (file.endsWith(".jsonl.gz")) {
        // Gzipped files need zlib — skip if not available, the Python
        // backend handles these natively
        continue;
      }

      const content = readFileSync(filePath, "utf-8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line));
        } catch {
          // Skip malformed lines
        }
      }
    }

    return records;
  }
}
