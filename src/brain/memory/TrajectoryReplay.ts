/**
 * Trajectory Replay — Replay past sessions through the world model
 *
 * Loads a session's state trajectory and replays it through the current
 * world model to analyze alternative paths. Used by:
 * - Agent Builder Agent: debug agent behavior
 * - Trace analyzer: retroactive "what if" analysis
 *
 * @purpose Replay past session trajectories for analysis
 * @spec AGENT_FACTORY_SPEC.md#a43-implement-trajectory-replay
 */

import type { StateTrajectoryStore, StateSnapshot } from "./StateTrajectoryStore.js";
import type { StratusClient } from "../stratus/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReplayStep {
  /** Original step data */
  original: {
    step: number;
    action: string;
    goalProximity: number;
    probeConfidence: number;
  };
  /** What the current model would rank for this state */
  currentRankings?: Array<{ action: string; score: number }>;
  /** Would the current model have chosen the same action? */
  sameChoice: boolean;
  /** Current model's predicted next state proximity (via world model) */
  predictedProximity?: number;
  /** Divergence between original and current model assessment */
  divergence: number;
}

export interface ReplayResult {
  sessionId: string;
  goal: string;
  totalSteps: number;
  steps: ReplayStep[];
  /** Steps where current model would have chosen differently */
  divergentSteps: number[];
  /** Overall agreement rate (0-1) */
  agreementRate: number;
  /** Summary of what the current model would do differently */
  insights: string[];
}

// ---------------------------------------------------------------------------
// Replayer
// ---------------------------------------------------------------------------

export class TrajectoryReplay {
  private store: StateTrajectoryStore;
  private client: StratusClient;

  constructor(store: StateTrajectoryStore, client: StratusClient) {
    this.store = store;
    this.client = client;
  }

  /**
   * Replay a session through the current model.
   *
   * @param sessionId - Session to replay
   * @param goalEmbedding - Goal embedding (re-encode from stored goal text)
   * @param actionEmbeddings - Current tool embeddings
   * @param actionLabels - Current tool labels
   * @param probeId - Probe to use for ranking
   */
  async replay(
    sessionId: string,
    goalEmbedding: number[],
    actionEmbeddings: number[][],
    actionLabels: string[],
    probeId = "planning-v2",
    signal?: AbortSignal,
  ): Promise<ReplayResult | null> {
    const meta = this.store.loadMeta(sessionId);
    if (!meta) return null;

    const snapshots = this.store.loadSnapshots(sessionId);
    if (snapshots.length === 0) return null;

    const steps: ReplayStep[] = [];
    const divergentSteps: number[] = [];

    for (const snapshot of snapshots) {
      const stateEmbedding = Array.from(snapshot.stateEmbedding);

      // Re-rank from this state with the current model
      let currentRankings: Array<{ action: string; score: number }> | undefined;
      let sameChoice = true;
      let predictedProximity: number | undefined;
      let divergence = 0;

      try {
        const rankResponse = await this.client.probeRank(
          stateEmbedding,
          goalEmbedding,
          actionEmbeddings,
          actionLabels,
          5,
          probeId,
          signal,
        );

        currentRankings = rankResponse.ranked_actions.map((r) => ({
          action: r.action,
          score: r.score,
        }));

        const topAction = currentRankings[0]?.action;
        sameChoice = topAction === snapshot.actionTaken;

        if (!sameChoice) {
          divergentSteps.push(snapshot.step);
        }

        // Check what the original action scored in current model
        const originalRank = currentRankings.find(
          (r) => r.action === snapshot.actionTaken,
        );
        const topScore = currentRankings[0]?.score ?? 0;
        const originalScore = originalRank?.score ?? 0;
        divergence = topScore - originalScore;

        // Predict what would happen if we took the current model's top action
        if (!sameChoice && topAction) {
          const actionIdx = actionLabels.indexOf(topAction);
          if (actionIdx >= 0) {
            const predicted = await this.client.predict(
              stateEmbedding,
              actionEmbeddings[actionIdx],
              signal,
            );
            const proximity = await this.client.goalProximity(
              predicted.predicted_embedding,
              goalEmbedding,
              signal,
            );
            predictedProximity = proximity.proximity;
          }
        }
      } catch {
        // Replay is best-effort — skip failures
      }

      steps.push({
        original: {
          step: snapshot.step,
          action: snapshot.actionTaken,
          goalProximity: snapshot.goalProximity,
          probeConfidence: snapshot.probeConfidence,
        },
        currentRankings,
        sameChoice,
        predictedProximity,
        divergence,
      });
    }

    const agreementRate =
      steps.length > 0
        ? steps.filter((s) => s.sameChoice).length / steps.length
        : 1;

    const insights = this.generateInsights(steps, divergentSteps);

    return {
      sessionId,
      goal: meta.goal,
      totalSteps: steps.length,
      steps,
      divergentSteps,
      agreementRate,
      insights,
    };
  }

  // -----------------------------------------------------------------------
  // Insight Generation
  // -----------------------------------------------------------------------

  private generateInsights(steps: ReplayStep[], divergentSteps: number[]): string[] {
    const insights: string[] = [];

    if (divergentSteps.length === 0) {
      insights.push("Current model fully agrees with original session decisions.");
      return insights;
    }

    insights.push(
      `Current model disagrees on ${divergentSteps.length}/${steps.length} steps (${((divergentSteps.length / steps.length) * 100).toFixed(0)}%).`,
    );

    // Find steps where the model's alternative would have been better
    const betterAlternatives = steps.filter(
      (s) =>
        !s.sameChoice &&
        s.predictedProximity !== undefined &&
        s.predictedProximity > s.original.goalProximity,
    );

    if (betterAlternatives.length > 0) {
      insights.push(
        `${betterAlternatives.length} steps had potentially better alternatives (higher predicted proximity).`,
      );
      for (const s of betterAlternatives.slice(0, 3)) {
        const topAction = s.currentRankings?.[0]?.action ?? "unknown";
        insights.push(
          `  Step ${s.original.step}: "${topAction}" predicted ${((s.predictedProximity! - s.original.goalProximity) * 100).toFixed(1)}% closer to goal.`,
        );
      }
    }

    return insights;
  }
}
