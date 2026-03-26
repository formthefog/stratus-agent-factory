/**
 * Probe-Based Action Ranker
 *
 * Takes (state_embedding, goal_embedding, tool_embeddings) and returns
 * ranked candidate actions via the sidecar's /probe_rank endpoint.
 *
 * Supports probe cascading: custom domain probe → general probe fallback.
 *
 * @purpose Rank available tools by relevance using Stratus policy probes
 * @spec AGENT_FACTORY_SPEC.md#b31-build-probe-based-action-ranker
 */

import type { StratusClient } from "./StratusClient.js";
import type { RankedAction } from "./StratusRPC.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RankingInput {
  stateEmbedding: number[];
  goalEmbedding: number[];
  actionEmbeddings: number[][];
  actionLabels: string[];
}

export interface RankingResult {
  rankedActions: RankedAction[];
  probeUsed: string;
  inferenceMs: number;
  /** True if the top-2 scores are within the ambiguity threshold */
  isAmbiguous: boolean;
}

export interface ActionRankerConfig {
  /** Default general probe (default: "planning-v2") */
  defaultProbe: string;
  /** Custom domain-specific probe ID (optional) */
  customProbe?: string;
  /** Top-K candidates to return (default: 10) */
  topK: number;
  /** Score gap below which top-2 are considered ambiguous (default: 0.15) */
  ambiguityThreshold: number;
}

const DEFAULT_CONFIG: ActionRankerConfig = {
  defaultProbe: "planning-v2",
  topK: 10,
  ambiguityThreshold: 0.15,
};

// Well-known general probes
export const GENERAL_PROBES = {
  PLANNING: "planning-v2",
  TOOL_USE: "tool-use-v2",
  RECOVERY: "recovery-v2",
  COORDINATION: "coordination-v2",
} as const;

// ---------------------------------------------------------------------------
// Ranker
// ---------------------------------------------------------------------------

export class ActionRanker {
  private config: ActionRankerConfig;
  private client: StratusClient;

  constructor(client: StratusClient, config?: Partial<ActionRankerConfig>) {
    this.client = client;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Rank actions using probe cascade: custom → default.
   */
  async rank(
    input: RankingInput,
    signal?: AbortSignal,
  ): Promise<RankingResult> {
    // Try custom probe first if configured
    if (this.config.customProbe) {
      try {
        return await this.rankWithProbe(input, this.config.customProbe, signal);
      } catch {
        // Custom probe failed, fall through to default
      }
    }

    return this.rankWithProbe(input, this.config.defaultProbe, signal);
  }

  /**
   * Rank using a specific probe. Useful for switching strategies
   * (e.g., recovery probe after a failure).
   */
  async rankWithProbe(
    input: RankingInput,
    probeId: string,
    signal?: AbortSignal,
  ): Promise<RankingResult> {
    const response = await this.client.probeRank(
      input.stateEmbedding,
      input.goalEmbedding,
      input.actionEmbeddings,
      input.actionLabels,
      this.config.topK,
      probeId,
      signal,
    );

    const isAmbiguous = this.checkAmbiguity(response.ranked_actions);

    return {
      rankedActions: response.ranked_actions,
      probeUsed: response.probe_id,
      inferenceMs: response.inference_ms,
      isAmbiguous,
    };
  }

  /**
   * Select the best action from a ranking result.
   * Returns null if no actions available.
   */
  selectBest(result: RankingResult): RankedAction | null {
    return result.rankedActions.length > 0 ? result.rankedActions[0] : null;
  }

  /** Update the custom probe for this ranker. */
  setCustomProbe(probeId: string): void {
    this.config.customProbe = probeId;
  }

  /** Update the ambiguity threshold. */
  setAmbiguityThreshold(threshold: number): void {
    this.config.ambiguityThreshold = threshold;
  }

  // -----------------------------------------------------------------------
  // Ambiguity Detection
  // -----------------------------------------------------------------------

  private checkAmbiguity(ranked: RankedAction[]): boolean {
    if (ranked.length < 2) return false;
    const gap = ranked[0].score - ranked[1].score;
    return gap < this.config.ambiguityThreshold;
  }
}
