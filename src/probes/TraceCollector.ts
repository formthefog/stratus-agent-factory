/**
 * Trace Collector — Capture agent traces for probe training
 *
 * Thin wrapper over the Python trace_pipeline.py. Captures
 * (state_emb, action_taken, goal_emb, outcome) tuples from live agents,
 * formats them for the probe training pipeline, and enforces privacy controls.
 *
 * Backend: v4_models/probes/trace_pipeline.py (TraceToTrainingPipeline)
 *
 * @purpose Capture agent traces with privacy controls for probe training
 * @spec AGENT_FACTORY_SPEC.md#e11-build-trace-collector
 */

import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TraceCollectorConfig {
  /** Directory for trace storage (date-partitioned) */
  storageDir: string;
  /** Agent ID */
  agentId: string;
  /** Domain */
  domain: string;
  /** Privacy settings */
  privacy: PrivacyConfig;
  /** Sidecar URL for encoding traces */
  sidecarUrl?: string;
  /** Max traces to keep before rotation (default: 50000) */
  maxTraces?: number;
}

export interface PrivacyConfig {
  /** Whether trace collection is enabled (must be opt-in) */
  enabled: boolean;
  /** Whether to anonymize user-identifying info in state text */
  anonymize: boolean;
  /** Retention period in days (default: 90) */
  retentionDays: number;
  /** Fields to redact from state text */
  redactFields?: string[];
}

export interface TraceStep {
  /** Full state text at this step */
  stateText: string;
  /** Action taken (type + description) */
  actionText: string;
  /** Goal text */
  goal: string;
  /** Available tools at this step */
  availableTools: string[];
  /** Whether goal was reached */
  goalReached: boolean;
  /** Timestamp */
  timestamp: string;
}

export interface TraceRecord {
  /** Formatted for probe training pipeline */
  domain: string;
  state: {
    observations: { content: string }[];
    static_context: { goal: string };
    metadata: Record<string, unknown>;
  };
  action: { type: string };
}

export interface CollectorStats {
  totalTraces: number;
  todayTraces: number;
  oldestTrace: string | null;
  newestTrace: string | null;
  privacyEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

export class TraceCollector {
  private config: TraceCollectorConfig;

  constructor(config: TraceCollectorConfig) {
    this.config = config;

    if (config.privacy.enabled) {
      mkdirSync(config.storageDir, { recursive: true });
    }
  }

  /**
   * Record a single trace step. Formats it into the schema expected by
   * trace_pipeline.py's trace_step_to_record().
   */
  record(step: TraceStep): void {
    if (!this.config.privacy.enabled) return;

    let stateText = step.stateText;
    let actionText = step.actionText;

    // Apply privacy controls
    if (this.config.privacy.anonymize) {
      stateText = this.anonymize(stateText);
      actionText = this.anonymize(actionText);
    }

    if (this.config.privacy.redactFields) {
      for (const field of this.config.privacy.redactFields) {
        const pattern = new RegExp(`${field}[:\\s]+[^\\n]+`, "gi");
        stateText = stateText.replace(pattern, `${field}: [REDACTED]`);
      }
    }

    // Format as training record (matches trace_pipeline.py schema)
    const record: TraceRecord = {
      domain: this.config.domain,
      state: {
        observations: [{ content: stateText }],
        static_context: { goal: step.goal },
        metadata: {
          agent_id: this.config.agentId,
          available_tools: step.availableTools,
          goal_reached: step.goalReached,
          timestamp: step.timestamp,
        },
      },
      action: { type: this.extractActionType(actionText) },
    };

    // Write to date-partitioned file
    const date = step.timestamp.slice(0, 10); // YYYY-MM-DD
    const filePath = join(this.config.storageDir, `${date}.jsonl`);
    appendFileSync(filePath, JSON.stringify(record) + "\n");
  }

  /**
   * Record a full episode (multiple steps).
   */
  recordEpisode(steps: TraceStep[]): void {
    for (const step of steps) {
      this.record(step);
    }
  }

  /**
   * Get collection statistics.
   */
  stats(): CollectorStats {
    if (!existsSync(this.config.storageDir)) {
      return {
        totalTraces: 0,
        todayTraces: 0,
        oldestTrace: null,
        newestTrace: null,
        privacyEnabled: this.config.privacy.enabled,
      };
    }

    const { readdirSync } = require("node:fs");
    const files = readdirSync(this.config.storageDir)
      .filter((f: string) => f.endsWith(".jsonl"))
      .sort();

    let total = 0;
    for (const file of files) {
      const content = readFileSync(join(this.config.storageDir, file), "utf-8");
      total += content.trim().split("\n").filter(Boolean).length;
    }

    const today = new Date().toISOString().slice(0, 10);
    const todayFile = join(this.config.storageDir, `${today}.jsonl`);
    let todayCount = 0;
    if (existsSync(todayFile)) {
      todayCount = readFileSync(todayFile, "utf-8").trim().split("\n").filter(Boolean).length;
    }

    return {
      totalTraces: total,
      todayTraces: todayCount,
      oldestTrace: files.length > 0 ? files[0].replace(".jsonl", "") : null,
      newestTrace: files.length > 0 ? files[files.length - 1].replace(".jsonl", "") : null,
      privacyEnabled: this.config.privacy.enabled,
    };
  }

  /**
   * Enforce retention policy — delete traces older than retentionDays.
   */
  enforceRetention(): number {
    if (!existsSync(this.config.storageDir)) return 0;

    const { readdirSync, unlinkSync } = require("node:fs");
    const files = readdirSync(this.config.storageDir)
      .filter((f: string) => f.endsWith(".jsonl"));

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.config.privacy.retentionDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    let removed = 0;
    for (const file of files) {
      const date = file.replace(".jsonl", "");
      if (date < cutoffStr) {
        unlinkSync(join(this.config.storageDir, file));
        removed++;
      }
    }
    return removed;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private anonymize(text: string): string {
    // Replace email patterns
    text = text.replace(/[\w.-]+@[\w.-]+\.\w+/g, "[EMAIL]");
    // Replace phone patterns
    text = text.replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, "[PHONE]");
    // Replace IP addresses
    text = text.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "[IP]");
    return text;
  }

  private extractActionType(actionText: string): string {
    // "search_knowledge_base: Search the help center..." → "search_knowledge_base"
    const colonIdx = actionText.indexOf(":");
    if (colonIdx > 0) return actionText.slice(0, colonIdx).trim();
    return actionText.split(/\s/)[0];
  }
}
