/**
 * Trajectory Memory Bridge — Converts trajectories to markdown summaries
 *
 * On session end, generates a text summary from the state trajectory:
 * steps taken, goal proximity curve, key decision points, actions that
 * helped/hurt. Writes to OpenClaw's daily memory markdown file so
 * existing memory search can find trajectory insights.
 *
 * @purpose Bridge between Stratus trajectory data and OpenClaw memory system
 * @spec AGENT_FACTORY_SPEC.md#a42-integrate-state-trajectory-with-openclaw-memory
 */

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { StateTrajectoryStore, StateSnapshot, TrajectoryMeta } from "./StateTrajectoryStore.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrajectorySummary {
  sessionId: string;
  goal: string;
  totalSteps: number;
  finalProximity: number;
  durationMs: number;
  keyDecisions: KeyDecision[];
  proximityTrend: "improving" | "stagnant" | "declining" | "mixed";
  markdown: string;
}

export interface KeyDecision {
  step: number;
  action: string;
  proximityBefore: number;
  proximityAfter: number;
  impact: "positive" | "negative" | "neutral";
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

export class TrajectoryMemoryBridge {
  private store: StateTrajectoryStore;
  private memoryDir: string;

  constructor(store: StateTrajectoryStore, memoryDir = "memory") {
    this.store = store;
    this.memoryDir = memoryDir;
  }

  /**
   * Generate a summary from a completed trajectory and write to memory.
   */
  summarizeAndStore(sessionId: string): TrajectorySummary | null {
    const meta = this.store.loadMeta(sessionId);
    if (!meta) return null;

    const snapshots = this.store.loadSnapshots(sessionId);
    if (snapshots.length === 0) return null;

    const summary = this.buildSummary(meta, snapshots);

    // Write to OpenClaw memory directory
    this.writeToMemory(summary);

    return summary;
  }

  /**
   * Build a summary without writing to memory.
   */
  buildSummary(meta: TrajectoryMeta, snapshots: StateSnapshot[]): TrajectorySummary {
    const keyDecisions = this.findKeyDecisions(snapshots);
    const proximityTrend = this.assessTrend(snapshots);
    const durationMs = meta.endedAt
      ? new Date(meta.endedAt).getTime() - new Date(meta.startedAt).getTime()
      : 0;

    const markdown = this.renderMarkdown(meta, snapshots, keyDecisions, proximityTrend);

    return {
      sessionId: meta.sessionId,
      goal: meta.goal,
      totalSteps: meta.totalSteps,
      finalProximity: meta.finalProximity,
      durationMs,
      keyDecisions,
      proximityTrend,
      markdown,
    };
  }

  // -----------------------------------------------------------------------
  // Analysis
  // -----------------------------------------------------------------------

  private findKeyDecisions(snapshots: StateSnapshot[]): KeyDecision[] {
    const decisions: KeyDecision[] = [];

    for (let i = 1; i < snapshots.length; i++) {
      const prev = snapshots[i - 1];
      const curr = snapshots[i];
      const delta = curr.goalProximity - prev.goalProximity;

      // Only record significant changes (>5% proximity shift)
      if (Math.abs(delta) >= 0.05) {
        decisions.push({
          step: curr.step,
          action: curr.actionTaken,
          proximityBefore: prev.goalProximity,
          proximityAfter: curr.goalProximity,
          impact: delta > 0.05 ? "positive" : delta < -0.05 ? "negative" : "neutral",
        });
      }
    }

    return decisions;
  }

  private assessTrend(
    snapshots: StateSnapshot[],
  ): "improving" | "stagnant" | "declining" | "mixed" {
    if (snapshots.length < 3) return "stagnant";

    const proximities = snapshots.map((s) => s.goalProximity);
    let improving = 0;
    let declining = 0;

    for (let i = 1; i < proximities.length; i++) {
      const delta = proximities[i] - proximities[i - 1];
      if (delta > 0.01) improving++;
      else if (delta < -0.01) declining++;
    }

    const total = proximities.length - 1;
    if (improving > total * 0.6) return "improving";
    if (declining > total * 0.6) return "declining";
    if (improving < total * 0.2 && declining < total * 0.2) return "stagnant";
    return "mixed";
  }

  // -----------------------------------------------------------------------
  // Markdown Rendering
  // -----------------------------------------------------------------------

  private renderMarkdown(
    meta: TrajectoryMeta,
    snapshots: StateSnapshot[],
    keyDecisions: KeyDecision[],
    trend: string,
  ): string {
    const lines: string[] = [];

    lines.push(`## Stratus Session: ${meta.sessionId}`);
    lines.push(`**Goal:** ${meta.goal}`);
    lines.push(`**Steps:** ${meta.totalSteps} | **Final Proximity:** ${(meta.finalProximity * 100).toFixed(1)}% | **Trend:** ${trend}`);
    lines.push(`**Started:** ${meta.startedAt}${meta.endedAt ? ` | **Ended:** ${meta.endedAt}` : ""}`);
    lines.push("");

    // Proximity curve (ASCII sparkline)
    if (snapshots.length > 0) {
      const sparkline = this.sparkline(snapshots.map((s) => s.goalProximity));
      lines.push(`**Proximity:** ${sparkline}`);
      lines.push("");
    }

    // Key decisions
    if (keyDecisions.length > 0) {
      lines.push("### Key Decisions");
      for (const d of keyDecisions) {
        const arrow = d.impact === "positive" ? "+" : d.impact === "negative" ? "-" : "=";
        const pctBefore = (d.proximityBefore * 100).toFixed(0);
        const pctAfter = (d.proximityAfter * 100).toFixed(0);
        lines.push(`- Step ${d.step}: \`${d.action}\` [${arrow}] ${pctBefore}% → ${pctAfter}%`);
      }
      lines.push("");
    }

    // Actions that helped most
    const positive = keyDecisions.filter((d) => d.impact === "positive");
    if (positive.length > 0) {
      lines.push("### What Worked");
      for (const d of positive) {
        lines.push(`- \`${d.action}\` improved proximity by ${((d.proximityAfter - d.proximityBefore) * 100).toFixed(0)}%`);
      }
      lines.push("");
    }

    // Actions that hurt
    const negative = keyDecisions.filter((d) => d.impact === "negative");
    if (negative.length > 0) {
      lines.push("### What Didn't Work");
      for (const d of negative) {
        lines.push(`- \`${d.action}\` decreased proximity by ${((d.proximityBefore - d.proximityAfter) * 100).toFixed(0)}%`);
      }
    }

    return lines.join("\n");
  }

  private sparkline(values: number[]): string {
    const blocks = " ▁▂▃▄▅▆▇█";
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;

    return values
      .map((v) => {
        const idx = Math.round(((v - min) / range) * 8);
        return blocks[idx];
      })
      .join("");
  }

  // -----------------------------------------------------------------------
  // Memory I/O
  // -----------------------------------------------------------------------

  private writeToMemory(summary: TrajectorySummary): void {
    if (!existsSync(this.memoryDir)) {
      mkdirSync(this.memoryDir, { recursive: true });
    }

    const date = new Date().toISOString().split("T")[0];
    const filePath = join(this.memoryDir, `stratus-${date}.md`);

    const content = summary.markdown + "\n\n---\n\n";
    writeFileSync(filePath, content, { flag: "a" });
  }
}
