/**
 * State Assembler — Converts OpenClaw context into canonical Stratus state text
 *
 * Assembles the structured state representation that the StateEncoder processes.
 * Takes conversation history, memory, tool outputs, and metadata, then formats
 * them into the canonical format the JEPA model was trained on.
 *
 * The output is a text block that gets encoded by the sidecar's /encode_state.
 * Static sections (USER CONTEXT, AVAILABLE ACTIONS) are cached separately from
 * dynamic sections (SYSTEM STATUS, PROGRESS) to minimize re-encoding.
 *
 * @purpose Convert OpenClaw context into canonical Stratus state text
 * @spec AGENT_FACTORY_SPEC.md#b21-design-state-assembly-pipeline
 */

import type { BrainToolDefinition } from "../IBrain.js";

// ---------------------------------------------------------------------------
// Input Types
// ---------------------------------------------------------------------------

export interface StateAssemblyInput {
  /** Primary goal extracted from user message */
  primaryGoal: string;
  /** Sub-goals if decomposed */
  subGoals?: string[];
  /** User context from memory/preferences */
  userContext?: UserContext;
  /** Registered tools available to the agent */
  tools: BrainToolDefinition[];
  /** Accumulated knowledge from this session */
  knowledge: string[];
  /** Last action taken and its result */
  lastAction?: ActionResult;
  /** What changed since last step */
  changed?: string[];
  /** Current step number */
  stepNumber: number;
  /** Goal proximity percentage (0-100) */
  goalProximity: number;
  /** Channel metadata */
  channel?: ChannelMeta;
}

export interface UserContext {
  /** User identifier or name */
  user?: string;
  /** Inferred domain */
  domain?: string;
  /** Relevant preferences from memory */
  preferences?: string[];
  /** Additional context lines */
  extra?: string[];
}

export interface ActionResult {
  /** Tool that was called */
  toolId: string;
  /** Tool name */
  toolName: string;
  /** Parameter summary */
  params: string;
  /** Result summary */
  result: string;
  /** Whether it succeeded */
  success: boolean;
}

export interface ChannelMeta {
  /** Channel type (discord, slack, web, etc.) */
  type: string;
  /** Who is interacting */
  sender?: string;
  /** Timestamp */
  timestamp?: string;
}

// ---------------------------------------------------------------------------
// Assembler
// ---------------------------------------------------------------------------

export class StateAssembler {
  /**
   * Assemble the full canonical state text from all inputs.
   */
  assemble(input: StateAssemblyInput): string {
    const sections: string[] = [];

    sections.push(this.assembleGoalHierarchy(input));
    sections.push(this.assembleUserContext(input));
    sections.push(this.assembleAvailableActions(input));
    sections.push(this.assembleSystemStatus(input));
    sections.push(this.assembleProgress(input));

    return sections.join("\n\n");
  }

  /**
   * Assemble only the static sections (goal, user context, actions).
   * These change infrequently and can be cached for encoding.
   */
  assembleStatic(input: StateAssemblyInput): string {
    const sections: string[] = [];
    sections.push(this.assembleGoalHierarchy(input));
    sections.push(this.assembleUserContext(input));
    sections.push(this.assembleAvailableActions(input));
    return sections.join("\n\n");
  }

  /**
   * Assemble only the dynamic sections (status, progress).
   * These change every step and need fresh encoding.
   */
  assembleDynamic(input: StateAssemblyInput): string {
    const sections: string[] = [];
    sections.push(this.assembleSystemStatus(input));
    sections.push(this.assembleProgress(input));
    return sections.join("\n\n");
  }

  // -----------------------------------------------------------------------
  // Section Builders
  // -----------------------------------------------------------------------

  private assembleGoalHierarchy(input: StateAssemblyInput): string {
    const lines = [HEADER_GOAL];
    lines.push(`[PRIMARY GOAL] ${input.primaryGoal}`);

    if (input.subGoals && input.subGoals.length > 0) {
      for (const sub of input.subGoals) {
        lines.push(`  [SUB] ${sub}`);
      }
    }

    return lines.join("\n");
  }

  private assembleUserContext(input: StateAssemblyInput): string {
    const lines = [HEADER_USER_CONTEXT];

    const ctx = input.userContext;
    if (ctx?.user) lines.push(`[USER] ${ctx.user}`);
    if (ctx?.domain) lines.push(`[DOMAIN] ${ctx.domain}`);
    if (ctx?.preferences) {
      for (const pref of ctx.preferences) {
        lines.push(`[PREF] ${pref}`);
      }
    }
    if (ctx?.extra) {
      for (const line of ctx.extra) {
        lines.push(line);
      }
    }

    if (input.channel) {
      const ch = input.channel;
      lines.push(`[CHANNEL] ${ch.type}${ch.sender ? ` | ${ch.sender}` : ""}${ch.timestamp ? ` | ${ch.timestamp}` : ""}`);
    }

    return lines.join("\n");
  }

  private assembleAvailableActions(input: StateAssemblyInput): string {
    const lines = [HEADER_ACTIONS];

    for (const tool of input.tools) {
      // Use the compact format: "tool_id (domain): description"
      lines.push(`[${tool.id}] (${tool.domain}) ${tool.description}`);
    }

    return lines.join("\n");
  }

  private assembleSystemStatus(input: StateAssemblyInput): string {
    const lines = [HEADER_STATUS];

    // Knowledge accumulation
    lines.push("[KNOWLEDGE]");
    if (input.knowledge.length > 0) {
      for (const item of input.knowledge) {
        lines.push(`  - ${item}`);
      }
    } else {
      lines.push("  (none yet)");
    }

    // Last action
    lines.push("[LAST_ACTION]");
    if (input.lastAction) {
      const a = input.lastAction;
      const status = a.success ? "OK" : "FAILED";
      lines.push(`  ${a.toolName}(${a.params}) → ${status}: ${a.result}`);
    } else {
      lines.push("  (none)");
    }

    // Changed diff
    lines.push("[CHANGED]");
    if (input.changed && input.changed.length > 0) {
      for (const change of input.changed) {
        lines.push(`  - ${change}`);
      }
    } else {
      lines.push("  (no changes)");
    }

    return lines.join("\n");
  }

  private assembleProgress(input: StateAssemblyInput): string {
    return `${HEADER_PROGRESS}\nStep ${input.stepNumber} | ${input.goalProximity}% toward goal`;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEADER_GOAL = "═══ GOAL HIERARCHY ═══";
const HEADER_USER_CONTEXT = "═══ USER CONTEXT ═══";
const HEADER_ACTIONS = "═══ AVAILABLE ACTIONS ═══";
const HEADER_STATUS = "═══ SYSTEM STATUS ═══";
const HEADER_PROGRESS = "═══ PROGRESS ═══";
