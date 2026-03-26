/**
 * Observation Encoder V1 (LLM Bridge)
 *
 * Before we have a trained observation encoder model, this uses an LLM
 * to summarize tool output into a 1-2 sentence description of what changed,
 * then encodes that summary via the state encoder to get a state embedding.
 *
 * This is the "bridge" approach — works immediately, replaced by a direct
 * model (V2) once trained on observation data.
 *
 * @purpose LLM-based observation encoding (V1 bridge approach)
 * @spec AGENT_FACTORY_SPEC.md#b41-build-observation-encoder-v1
 */

import type { StratusClient } from "./StratusClient.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Observation {
  /** Tool that produced this observation */
  toolId: string;
  toolName: string;
  /** Whether the tool execution succeeded */
  success: boolean;
  /** Raw tool output */
  output: unknown;
  /** Execution time in ms */
  executionMs: number;
}

export interface EncodedObservation {
  /** Natural language summary of what happened */
  summary: string;
  /** State embedding of the observation */
  embedding: number[];
  /** Encoding latency in ms */
  encodingMs: number;
  /** Whether LLM was used for summarization */
  usedLlm: boolean;
}

/** LLM summarization callback. Caller provides the LLM. */
export type SummarizeFn = (prompt: string) => Promise<string>;

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

export class ObservationEncoderV1 {
  private summarizeFn: SummarizeFn | null;
  private client: StratusClient;

  constructor(client: StratusClient, summarizeFn?: SummarizeFn) {
    this.client = client;
    this.summarizeFn = summarizeFn ?? null;
  }

  /**
   * Encode an observation into a state embedding.
   *
   * 1. Summarize the raw output (LLM or heuristic)
   * 2. Encode the summary via /encode_state
   */
  async encode(
    observation: Observation,
    signal?: AbortSignal,
  ): Promise<EncodedObservation> {
    const start = Date.now();

    // Step 1: Summarize
    let summary: string;
    let usedLlm = false;

    if (this.summarizeFn && this.needsLlmSummary(observation)) {
      summary = await this.llmSummarize(observation);
      usedLlm = true;
    } else {
      summary = this.heuristicSummarize(observation);
    }

    // Step 2: Encode summary as state
    const response = await this.client.encodeState(summary, signal);

    return {
      summary,
      embedding: response.embedding,
      encodingMs: Date.now() - start,
      usedLlm,
    };
  }

  // -----------------------------------------------------------------------
  // LLM Summarization
  // -----------------------------------------------------------------------

  private async llmSummarize(obs: Observation): Promise<string> {
    const outputStr = this.serializeOutput(obs.output);
    const prompt = [
      `Tool "${obs.toolName}" ${obs.success ? "succeeded" : "FAILED"}.`,
      `Output (truncated to 2000 chars):`,
      outputStr.slice(0, 2000),
      "",
      "Summarize what changed or was learned in 1-2 sentences.",
      "Focus on facts and state changes, not the tool execution itself.",
      "Return ONLY the summary, no explanation.",
    ].join("\n");

    return this.summarizeFn!(prompt);
  }

  // -----------------------------------------------------------------------
  // Heuristic Summarization
  // -----------------------------------------------------------------------

  private heuristicSummarize(obs: Observation): string {
    const status = obs.success ? "succeeded" : "failed";
    const outputStr = this.serializeOutput(obs.output);

    // Short output: use directly
    if (outputStr.length < 200) {
      return `${obs.toolName} ${status}: ${outputStr}`;
    }

    // Long output: extract key info
    const firstLine = outputStr.split("\n")[0] ?? "";
    return `${obs.toolName} ${status}. ${firstLine.slice(0, 150)}`;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /** Determine if output is complex enough to need LLM summarization. */
  private needsLlmSummary(obs: Observation): boolean {
    const outputStr = this.serializeOutput(obs.output);
    // Use LLM for long or structured outputs
    return outputStr.length > 500 || this.isStructuredOutput(obs.output);
  }

  private isStructuredOutput(output: unknown): boolean {
    if (typeof output === "object" && output !== null) {
      const keys = Object.keys(output);
      return keys.length > 3; // Multiple fields suggest structure worth summarizing
    }
    return false;
  }

  private serializeOutput(output: unknown): string {
    if (output === undefined || output === null) return "(no output)";
    if (typeof output === "string") return output;
    try {
      return JSON.stringify(output, null, 2);
    } catch {
      return String(output);
    }
  }
}
