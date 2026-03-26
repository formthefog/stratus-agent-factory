/**
 * Tree Search Orchestrator
 *
 * When action ranking is ambiguous (top-2 scores within threshold),
 * performs lookahead search via the world model to disambiguate.
 *
 * For each candidate: predict next state → rank next actions → recurse.
 * Score paths by cumulative goal proximity. Return the best path's first action.
 *
 * Two modes:
 * 1. Sidecar tree search (fast): single RPC call to /tree_search endpoint
 * 2. Client-side tree search (flexible): step-by-step predict + rank from TS
 *
 * Defaults to sidecar mode. Falls back to client-side if sidecar doesn't support it.
 *
 * @purpose Lookahead tree search for disambiguating close action candidates
 * @spec AGENT_FACTORY_SPEC.md#b32-build-tree-search-orchestrator
 */

import type { StratusClient } from "./StratusClient.js";
import type { TreeSearchStep } from "./StratusRPC.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TreeSearchConfig {
  /** Search depth (default: 3) */
  depth: number;
  /** Beam width — candidates per level (default: 5) */
  width: number;
  /** Wall time budget in ms (default: 500) */
  timeBudgetMs: number;
  /** Probe ID for ranking at each level */
  probeId: string;
  /** Pruning threshold — skip branches with score below this (default: 0.05) */
  pruningThreshold: number;
}

const DEFAULT_CONFIG: TreeSearchConfig = {
  depth: 3,
  width: 5,
  timeBudgetMs: 500,
  probeId: "planning-v2",
  pruningThreshold: 0.05,
};

export interface TreeSearchResult {
  /** The recommended first action */
  bestAction: string;
  /** The full best path */
  bestPath: TreeSearchStep[];
  /** Goal proximity at the end of the best path */
  terminalProximity: number;
  /** Total paths evaluated */
  pathsEvaluated: number;
  /** Search time in ms */
  searchMs: number;
  /** Whether search was truncated by time budget */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class TreeSearchOrchestrator {
  private config: TreeSearchConfig;
  private client: StratusClient;

  constructor(client: StratusClient, config?: Partial<TreeSearchConfig>) {
    this.client = client;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Run tree search to disambiguate close candidates.
   * Tries sidecar-side search first, falls back to client-side.
   */
  async search(
    stateEmbedding: number[],
    goalEmbedding: number[],
    actionEmbeddings: number[][],
    actionLabels: string[],
    signal?: AbortSignal,
  ): Promise<TreeSearchResult> {
    const start = Date.now();

    try {
      return await this.sidecarSearch(
        stateEmbedding,
        goalEmbedding,
        actionEmbeddings,
        actionLabels,
        signal,
      );
    } catch {
      // Sidecar search not available, fall back to client-side
      return this.clientSearch(
        stateEmbedding,
        goalEmbedding,
        actionEmbeddings,
        actionLabels,
        start,
        signal,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Sidecar-side search (single RPC call)
  // -----------------------------------------------------------------------

  private async sidecarSearch(
    stateEmbedding: number[],
    goalEmbedding: number[],
    actionEmbeddings: number[][],
    actionLabels: string[],
    signal?: AbortSignal,
  ): Promise<TreeSearchResult> {
    const response = await this.client.treeSearch(
      stateEmbedding,
      goalEmbedding,
      actionEmbeddings,
      actionLabels,
      this.config.depth,
      this.config.width,
      this.config.probeId,
      signal,
    );

    return {
      bestAction: response.best_path[0]?.action ?? actionLabels[0],
      bestPath: response.best_path,
      terminalProximity: response.best_terminal_proximity,
      pathsEvaluated: response.paths_evaluated,
      searchMs: response.search_ms,
      truncated: false,
    };
  }

  // -----------------------------------------------------------------------
  // Client-side search (step-by-step via predict + rank)
  // -----------------------------------------------------------------------

  private async clientSearch(
    stateEmbedding: number[],
    goalEmbedding: number[],
    actionEmbeddings: number[][],
    actionLabels: string[],
    startTime: number,
    signal?: AbortSignal,
  ): Promise<TreeSearchResult> {
    interface PathNode {
      action: string;
      state: number[];
      score: number;
      goalProximity: number;
      depth: number;
      path: TreeSearchStep[];
    }

    // Initialize with top candidates
    const rankResponse = await this.client.probeRank(
      stateEmbedding,
      goalEmbedding,
      actionEmbeddings,
      actionLabels,
      this.config.width,
      this.config.probeId,
      signal,
    );

    let beam: PathNode[] = [];
    let pathsEvaluated = 0;

    for (const candidate of rankResponse.ranked_actions) {
      if (candidate.score < this.config.pruningThreshold) continue;

      const actionIdx = actionLabels.indexOf(candidate.action);
      if (actionIdx < 0) continue;

      beam.push({
        action: candidate.action,
        state: stateEmbedding, // Will be predicted
        score: candidate.score,
        goalProximity: 0,
        depth: 0,
        path: [{ action: candidate.action, score: candidate.score, goal_proximity: 0 }],
      });
    }

    // Expand beam level by level
    for (let d = 0; d < this.config.depth; d++) {
      // Check time budget
      if (Date.now() - startTime > this.config.timeBudgetMs) {
        return this.buildResult(beam, pathsEvaluated, startTime, true);
      }

      const nextBeam: PathNode[] = [];

      for (const node of beam) {
        // Predict next state
        const actionIdx = actionLabels.indexOf(node.action);
        if (actionIdx < 0) continue;

        const predicted = await this.client.predict(
          node.state,
          actionEmbeddings[actionIdx],
          signal,
        );

        // Check goal proximity
        const proximity = await this.client.goalProximity(
          predicted.predicted_embedding,
          goalEmbedding,
          signal,
        );

        node.state = predicted.predicted_embedding;
        node.goalProximity = proximity.proximity;
        node.path[node.path.length - 1].goal_proximity = proximity.proximity;
        pathsEvaluated++;

        // If not at max depth, rank next actions from predicted state
        if (d < this.config.depth - 1) {
          const nextRank = await this.client.probeRank(
            predicted.predicted_embedding,
            goalEmbedding,
            actionEmbeddings,
            actionLabels,
            Math.min(3, this.config.width), // Narrower at deeper levels
            this.config.probeId,
            signal,
          );

          for (const next of nextRank.ranked_actions) {
            if (next.score < this.config.pruningThreshold) continue;
            nextBeam.push({
              action: next.action,
              state: predicted.predicted_embedding,
              score: node.score + next.score,
              goalProximity: 0,
              depth: d + 1,
              path: [
                ...node.path,
                { action: next.action, score: next.score, goal_proximity: 0 },
              ],
            });
          }
        } else {
          nextBeam.push(node);
        }

        // Time check
        if (Date.now() - startTime > this.config.timeBudgetMs) {
          return this.buildResult(
            nextBeam.length > 0 ? nextBeam : beam,
            pathsEvaluated,
            startTime,
            true,
          );
        }
      }

      // Keep top-width paths by goal proximity
      beam = nextBeam
        .sort((a, b) => b.goalProximity - a.goalProximity)
        .slice(0, this.config.width);
    }

    return this.buildResult(beam, pathsEvaluated, startTime, false);
  }

  private buildResult(
    beam: Array<{ path: TreeSearchStep[]; goalProximity: number }>,
    pathsEvaluated: number,
    startTime: number,
    truncated: boolean,
  ): TreeSearchResult {
    const best = beam.sort((a, b) => b.goalProximity - a.goalProximity)[0];

    return {
      bestAction: best?.path[0]?.action ?? "",
      bestPath: best?.path ?? [],
      terminalProximity: best?.goalProximity ?? 0,
      pathsEvaluated,
      searchMs: Date.now() - startTime,
      truncated,
    };
  }
}
