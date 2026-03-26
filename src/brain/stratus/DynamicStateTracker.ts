/**
 * Dynamic State Tracker — Tracks step-by-step state changes
 *
 * Maintains the KNOWLEDGE accumulation (what the agent has learned),
 * computes CHANGED diffs between steps, and updates PROGRESS.
 * Fed into the StateAssembler for each turn.
 *
 * @purpose Track step-by-step state changes for Stratus planning context
 * @spec AGENT_FACTORY_SPEC.md#b23-build-dynamic-state-tracker
 */

import type { ActionResult } from "./StateAssembler.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StepRecord {
  stepNumber: number;
  action: ActionResult;
  knowledgeGained: string[];
  changed: string[];
  goalProximity: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

export class DynamicStateTracker {
  private steps: StepRecord[] = [];
  private knowledge: string[] = [];
  private goalProximity = 0;

  /**
   * Record a completed step. Computes the diff from previous state
   * and accumulates knowledge.
   */
  recordStep(
    action: ActionResult,
    knowledgeGained: string[],
    goalProximity: number,
  ): StepRecord {
    const stepNumber = this.steps.length + 1;
    const changed = this.computeChanged(action, knowledgeGained);

    // Accumulate knowledge (deduplicate)
    for (const item of knowledgeGained) {
      if (!this.knowledge.includes(item)) {
        this.knowledge.push(item);
      }
    }

    this.goalProximity = goalProximity;

    const record: StepRecord = {
      stepNumber,
      action,
      knowledgeGained,
      changed,
      goalProximity,
      timestamp: new Date().toISOString(),
    };

    this.steps.push(record);
    return record;
  }

  /** Get accumulated knowledge across all steps. */
  getKnowledge(): string[] {
    return [...this.knowledge];
  }

  /** Get the last action result. */
  getLastAction(): ActionResult | undefined {
    return this.steps.length > 0
      ? this.steps[this.steps.length - 1].action
      : undefined;
  }

  /** Get what changed in the most recent step. */
  getLastChanged(): string[] {
    return this.steps.length > 0
      ? this.steps[this.steps.length - 1].changed
      : [];
  }

  /** Current step number (0 if no steps taken yet). */
  getStepNumber(): number {
    return this.steps.length;
  }

  /** Current goal proximity. */
  getGoalProximity(): number {
    return this.goalProximity;
  }

  /** Full step history. */
  getHistory(): StepRecord[] {
    return [...this.steps];
  }

  /** Reset tracker for a new turn/session. */
  reset(): void {
    this.steps = [];
    this.knowledge = [];
    this.goalProximity = 0;
  }

  // -----------------------------------------------------------------------
  // Diff Computation
  // -----------------------------------------------------------------------

  private computeChanged(
    action: ActionResult,
    knowledgeGained: string[],
  ): string[] {
    const changed: string[] = [];

    // Action outcome
    if (action.success) {
      changed.push(`${action.toolName} succeeded: ${truncate(action.result, 100)}`);
    } else {
      changed.push(`${action.toolName} FAILED: ${truncate(action.result, 100)}`);
    }

    // New knowledge
    for (const k of knowledgeGained) {
      changed.push(`Learned: ${k}`);
    }

    // Proximity change
    if (this.steps.length > 0) {
      const prev = this.steps[this.steps.length - 1].goalProximity;
      const curr = this.goalProximity;
      const delta = curr - prev;
      if (Math.abs(delta) >= 1) {
        changed.push(`Goal proximity: ${prev}% → ${curr}% (${delta > 0 ? "+" : ""}${delta}%)`);
      }
    }

    return changed;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 3) + "..." : text;
}
