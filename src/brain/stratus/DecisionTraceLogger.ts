/**
 * Decision Trace Logger — Structured per-step decision logging
 *
 * Every step in the agent loop produces a trace entry capturing:
 * state, rankings, search results, action selected, generation,
 * tool output, proximity change, and per-component latency.
 *
 * Stored as JSONL in the session directory for debugging.
 *
 * @purpose Structured decision trace logging for Stratus turns
 * @spec AGENT_FACTORY_SPEC.md#b51-build-decision-trace-logger
 */

import { writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { RankedAction } from "./StratusRPC.js";
import type { TreeSearchResult } from "./TreeSearch.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TraceEntry {
  step: number;
  timestamp: string;
  /** Hash of state embedding (for correlation without storing full vector) */
  stateEmbeddingHash: string;
  goalProximity: number;
  probeRankings: Array<{ tool: string; score: number }>;
  probeUsed: string;
  treeSearchUsed: boolean;
  treeSearchResult?: {
    bestAction: string;
    pathsEvaluated: number;
    searchMs: number;
    truncated: boolean;
  };
  actionSelected: string;
  generationNeeded: boolean;
  generationMs?: number;
  toolOutputSummary: string;
  toolSuccess: boolean;
  newGoalProximity: number;
  latencyMs: {
    stateEncoding: number;
    probeRanking: number;
    treeSearch: number;
    generation: number;
    execution: number;
    observation: number;
    total: number;
  };
  recovery?: {
    strategy: string;
    reason: string;
  };
}

export interface TraceSession {
  sessionId: string;
  startedAt: string;
  goal: string;
  entries: TraceEntry[];
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export class DecisionTraceLogger {
  private traceDir: string;
  private sessionId: string;
  private filePath: string;
  private entryCount = 0;

  constructor(sessionId: string, traceDir = ".stratus/traces") {
    this.sessionId = sessionId;
    this.traceDir = traceDir;
    this.filePath = join(traceDir, `${sessionId}.jsonl`);

    if (!existsSync(traceDir)) {
      mkdirSync(traceDir, { recursive: true });
    }
  }

  /**
   * Log a step's decision trace.
   */
  logStep(entry: TraceEntry): void {
    const line = JSON.stringify(entry);
    appendFileSync(this.filePath, line + "\n", "utf-8");
    this.entryCount++;
  }

  /**
   * Build a trace entry from component outputs.
   * Convenience method that assembles the TraceEntry from raw data.
   */
  buildEntry(params: {
    step: number;
    stateEmbedding: number[];
    goalProximity: number;
    rankings: RankedAction[];
    probeUsed: string;
    treeSearchResult?: TreeSearchResult;
    actionSelected: string;
    generationNeeded: boolean;
    generationMs?: number;
    toolOutputSummary: string;
    toolSuccess: boolean;
    newGoalProximity: number;
    latency: TraceEntry["latencyMs"];
    recovery?: TraceEntry["recovery"];
  }): TraceEntry {
    return {
      step: params.step,
      timestamp: new Date().toISOString(),
      stateEmbeddingHash: hashEmbedding(params.stateEmbedding),
      goalProximity: params.goalProximity,
      probeRankings: params.rankings.map((r) => ({
        tool: r.action,
        score: r.score,
      })),
      probeUsed: params.probeUsed,
      treeSearchUsed: !!params.treeSearchResult,
      treeSearchResult: params.treeSearchResult
        ? {
            bestAction: params.treeSearchResult.bestAction,
            pathsEvaluated: params.treeSearchResult.pathsEvaluated,
            searchMs: params.treeSearchResult.searchMs,
            truncated: params.treeSearchResult.truncated,
          }
        : undefined,
      actionSelected: params.actionSelected,
      generationNeeded: params.generationNeeded,
      generationMs: params.generationMs,
      toolOutputSummary: params.toolOutputSummary,
      toolSuccess: params.toolSuccess,
      newGoalProximity: params.newGoalProximity,
      latencyMs: params.latency,
      recovery: params.recovery,
    };
  }

  /** Get the trace file path. */
  getFilePath(): string {
    return this.filePath;
  }

  /** Number of entries logged. */
  getEntryCount(): number {
    return this.entryCount;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashEmbedding(embedding: number[]): string {
  const buf = Buffer.from(new Float32Array(embedding).buffer);
  return createHash("sha256").update(buf).digest("hex").slice(0, 12);
}
