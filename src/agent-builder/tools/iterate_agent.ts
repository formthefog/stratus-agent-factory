/**
 * Iterate Agent — Analyzes production traces and suggests improvements
 *
 * Takes a deployed agent's traces and feedback, identifies suboptimal
 * actions, missing tools, and probe failures. Suggests concrete changes
 * and can apply them automatically.
 *
 * @purpose Analyze production usage and iterate on agent configuration
 * @spec AGENT_FACTORY_SPEC.md#c19-iterate_agent-tool
 */

import type { DomainAnalysis } from "./analyze_domain.js";
import type { ToolDefinition } from "./generate_tool_registry.js";
import type { ProbeRecommendation } from "./select_probe.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IterateAgentInput {
  /** Agent identifier */
  agentId: string;
  /** Domain analysis (from initial build) */
  analysis: DomainAnalysis;
  /** Current tool registry */
  tools: ToolDefinition[];
  /** Current probe config */
  probe: ProbeRecommendation;
  /** Production traces to analyze */
  traces: ProductionTrace[];
  /** User feedback on agent behavior (optional) */
  feedback?: UserFeedback[];
  /** Whether to auto-apply safe changes */
  autoApply?: boolean;
}

export interface ProductionTrace {
  sessionId: string;
  goal: string;
  /** Whether the user's goal was achieved */
  success: boolean;
  /** User satisfaction rating (1-5, optional) */
  rating?: number;
  steps: ProductionStep[];
  /** Total duration in ms */
  durationMs: number;
}

export interface ProductionStep {
  step: number;
  toolUsed: string;
  parameters: Record<string, unknown>;
  success: boolean;
  /** Error message if failed */
  error?: string;
  goalProximity: number;
  probeConfidence: number;
  latencyMs: number;
  /** Whether tree search was triggered */
  treeSearchUsed: boolean;
  /** Whether recovery was triggered */
  recoveryUsed: boolean;
}

export interface UserFeedback {
  sessionId: string;
  type: "positive" | "negative" | "suggestion";
  content: string;
  /** Which tool/action the feedback relates to */
  relatedTool?: string;
}

export interface IterationReport {
  /** Agent being iterated */
  agentId: string;
  /** Number of traces analyzed */
  tracesAnalyzed: number;
  /** Overall success rate */
  successRate: number;
  /** Average user rating (if available) */
  avgRating?: number;
  /** Identified issues */
  issues: AgentIssue[];
  /** Suggested changes */
  suggestions: AgentSuggestion[];
  /** Changes that were auto-applied (if autoApply) */
  appliedChanges: string[];
  /** Whether re-testing is recommended */
  retestRecommended: boolean;
  /** Whether probe retraining is recommended */
  probeRetrainRecommended: boolean;
  /** Markdown summary */
  markdown: string;
}

export interface AgentIssue {
  type: "suboptimal_action" | "missing_tool" | "probe_failure" | "latency" | "error_pattern" | "stagnation";
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  /** Sessions where this issue appeared */
  affectedSessions: string[];
  /** Frequency (fraction of sessions affected) */
  frequency: number;
}

export interface AgentSuggestion {
  type: "add_tool" | "modify_tool" | "remove_tool" | "retrain_probe" | "config_change" | "add_recovery";
  description: string;
  /** Specific changes to make */
  changes: Record<string, unknown>;
  /** Expected impact */
  expectedImpact: string;
  /** Whether this can be auto-applied */
  autoApplicable: boolean;
  /** Priority */
  priority: "low" | "medium" | "high";
}

// ---------------------------------------------------------------------------
// Tool Implementation
// ---------------------------------------------------------------------------

export class IterateAgentTool {
  async execute(input: IterateAgentInput): Promise<IterationReport> {
    const issues = this.identifyIssues(input);
    const suggestions = this.generateSuggestions(issues, input);

    const appliedChanges: string[] = [];
    if (input.autoApply) {
      for (const suggestion of suggestions.filter((s) => s.autoApplicable)) {
        appliedChanges.push(suggestion.description);
      }
    }

    const successRate = input.traces.length > 0
      ? input.traces.filter((t) => t.success).length / input.traces.length
      : 0;

    const ratings = input.traces
      .map((t) => t.rating)
      .filter((r): r is number => r != null);
    const avgRating = ratings.length > 0
      ? ratings.reduce((a, b) => a + b, 0) / ratings.length
      : undefined;

    const retestRecommended = suggestions.some(
      (s) => s.type === "add_tool" || s.type === "modify_tool" || s.type === "config_change",
    );

    const probeRetrainRecommended = suggestions.some(
      (s) => s.type === "retrain_probe",
    );

    const markdown = this.renderMarkdown(
      input,
      issues,
      suggestions,
      successRate,
      avgRating,
      appliedChanges,
    );

    return {
      agentId: input.agentId,
      tracesAnalyzed: input.traces.length,
      successRate,
      avgRating,
      issues,
      suggestions,
      appliedChanges,
      retestRecommended,
      probeRetrainRecommended,
      markdown,
    };
  }

  // -----------------------------------------------------------------------
  // Issue Identification
  // -----------------------------------------------------------------------

  private identifyIssues(input: IterateAgentInput): AgentIssue[] {
    const issues: AgentIssue[] = [];

    issues.push(...this.findSuboptimalActions(input));
    issues.push(...this.findMissingTools(input));
    issues.push(...this.findProbeFailures(input));
    issues.push(...this.findLatencyIssues(input));
    issues.push(...this.findErrorPatterns(input));
    issues.push(...this.findStagnation(input));

    return issues.sort((a, b) => {
      const severity = { critical: 0, high: 1, medium: 2, low: 3 };
      return severity[a.severity] - severity[b.severity];
    });
  }

  private findSuboptimalActions(input: IterateAgentInput): AgentIssue[] {
    const issues: AgentIssue[] = [];

    // Find sessions where proximity decreased after an action
    const regressionSessions: string[] = [];

    for (const trace of input.traces) {
      for (let i = 1; i < trace.steps.length; i++) {
        const prev = trace.steps[i - 1];
        const curr = trace.steps[i];
        if (curr.goalProximity < prev.goalProximity - 0.05) {
          regressionSessions.push(trace.sessionId);
          break;
        }
      }
    }

    if (regressionSessions.length > 0) {
      issues.push({
        type: "suboptimal_action",
        severity: regressionSessions.length > input.traces.length * 0.3 ? "high" : "medium",
        description: `${regressionSessions.length} sessions had proximity regressions (action decreased goal proximity by >5%).`,
        affectedSessions: regressionSessions,
        frequency: regressionSessions.length / Math.max(input.traces.length, 1),
      });
    }

    return issues;
  }

  private findMissingTools(input: IterateAgentInput): AgentIssue[] {
    const issues: AgentIssue[] = [];

    // Check feedback for tool requests
    const toolRequests = (input.feedback ?? [])
      .filter((f) => f.type === "suggestion" && f.content.toLowerCase().includes("tool"))
      .map((f) => f.content);

    if (toolRequests.length >= 2) {
      issues.push({
        type: "missing_tool",
        severity: "medium",
        description: `${toolRequests.length} feedback items suggest missing tools: ${toolRequests.slice(0, 3).join("; ")}`,
        affectedSessions: (input.feedback ?? []).map((f) => f.sessionId),
        frequency: toolRequests.length / Math.max(input.traces.length, 1),
      });
    }

    // Check for sessions that failed without using all available tools
    const toolIds = new Set(input.tools.map((t) => t.id));
    const failedNoRetry: string[] = [];

    for (const trace of input.traces.filter((t) => !t.success)) {
      const usedTools = new Set(trace.steps.map((s) => s.toolUsed));
      const unusedTools = [...toolIds].filter((t) => !usedTools.has(t));
      if (unusedTools.length > toolIds.size * 0.5) {
        failedNoRetry.push(trace.sessionId);
      }
    }

    if (failedNoRetry.length > 0) {
      issues.push({
        type: "suboptimal_action",
        severity: "medium",
        description: `${failedNoRetry.length} failed sessions used less than half the available tools — probe may not be ranking alternatives well.`,
        affectedSessions: failedNoRetry,
        frequency: failedNoRetry.length / Math.max(input.traces.length, 1),
      });
    }

    return issues;
  }

  private findProbeFailures(input: IterateAgentInput): AgentIssue[] {
    const issues: AgentIssue[] = [];

    // Low confidence sessions
    const lowConfidence: string[] = [];

    for (const trace of input.traces) {
      const avgConf = trace.steps.reduce((a, s) => a + s.probeConfidence, 0) / Math.max(trace.steps.length, 1);
      if (avgConf < 0.4) {
        lowConfidence.push(trace.sessionId);
      }
    }

    if (lowConfidence.length > input.traces.length * 0.2) {
      issues.push({
        type: "probe_failure",
        severity: "high",
        description: `${lowConfidence.length} sessions had average probe confidence below 0.4 — probe is uncertain about action selection.`,
        affectedSessions: lowConfidence,
        frequency: lowConfidence.length / Math.max(input.traces.length, 1),
      });
    }

    // Excessive tree search usage (sign of probe ambiguity)
    const treeSearchHeavy: string[] = [];

    for (const trace of input.traces) {
      const treeSearchSteps = trace.steps.filter((s) => s.treeSearchUsed).length;
      if (treeSearchSteps > trace.steps.length * 0.5) {
        treeSearchHeavy.push(trace.sessionId);
      }
    }

    if (treeSearchHeavy.length > input.traces.length * 0.3) {
      issues.push({
        type: "probe_failure",
        severity: "medium",
        description: `${treeSearchHeavy.length} sessions used tree search on >50% of steps — probe can't distinguish top actions.`,
        affectedSessions: treeSearchHeavy,
        frequency: treeSearchHeavy.length / Math.max(input.traces.length, 1),
      });
    }

    return issues;
  }

  private findLatencyIssues(input: IterateAgentInput): AgentIssue[] {
    const issues: AgentIssue[] = [];

    const slowSessions: string[] = [];

    for (const trace of input.traces) {
      const avgStepMs = trace.durationMs / Math.max(trace.steps.length, 1);
      if (avgStepMs > 2000) {
        slowSessions.push(trace.sessionId);
      }
    }

    if (slowSessions.length > input.traces.length * 0.2) {
      issues.push({
        type: "latency",
        severity: "medium",
        description: `${slowSessions.length} sessions averaged >2s per step.`,
        affectedSessions: slowSessions,
        frequency: slowSessions.length / Math.max(input.traces.length, 1),
      });
    }

    return issues;
  }

  private findErrorPatterns(input: IterateAgentInput): AgentIssue[] {
    const issues: AgentIssue[] = [];

    // Group errors by tool
    const errorsByTool = new Map<string, string[]>();

    for (const trace of input.traces) {
      for (const step of trace.steps) {
        if (!step.success && step.error) {
          const sessions = errorsByTool.get(step.toolUsed) ?? [];
          sessions.push(trace.sessionId);
          errorsByTool.set(step.toolUsed, sessions);
        }
      }
    }

    for (const [tool, sessions] of errorsByTool) {
      if (sessions.length >= 3) {
        issues.push({
          type: "error_pattern",
          severity: sessions.length > 5 ? "high" : "medium",
          description: `Tool "${tool}" failed in ${sessions.length} sessions — recurring error pattern.`,
          affectedSessions: [...new Set(sessions)],
          frequency: new Set(sessions).size / Math.max(input.traces.length, 1),
        });
      }
    }

    return issues;
  }

  private findStagnation(input: IterateAgentInput): AgentIssue[] {
    const issues: AgentIssue[] = [];

    const stagnantSessions: string[] = [];

    for (const trace of input.traces) {
      if (trace.steps.length < 3) continue;

      // Check if proximity barely changed over multiple steps
      let stagnantSteps = 0;
      for (let i = 1; i < trace.steps.length; i++) {
        const delta = Math.abs(trace.steps[i].goalProximity - trace.steps[i - 1].goalProximity);
        if (delta < 0.02) stagnantSteps++;
      }

      if (stagnantSteps > trace.steps.length * 0.6) {
        stagnantSessions.push(trace.sessionId);
      }
    }

    if (stagnantSessions.length > 0) {
      issues.push({
        type: "stagnation",
        severity: stagnantSessions.length > input.traces.length * 0.3 ? "high" : "medium",
        description: `${stagnantSessions.length} sessions showed stagnation (proximity barely changed over >60% of steps).`,
        affectedSessions: stagnantSessions,
        frequency: stagnantSessions.length / Math.max(input.traces.length, 1),
      });
    }

    return issues;
  }

  // -----------------------------------------------------------------------
  // Suggestion Generation
  // -----------------------------------------------------------------------

  private generateSuggestions(
    issues: AgentIssue[],
    input: IterateAgentInput,
  ): AgentSuggestion[] {
    const suggestions: AgentSuggestion[] = [];

    for (const issue of issues) {
      switch (issue.type) {
        case "probe_failure":
          suggestions.push({
            type: "retrain_probe",
            description: `Retrain probe with ${input.traces.length} production traces for better action ranking.`,
            changes: {
              trainingSources: input.traces.map((t) => t.sessionId),
              baseProbe: input.probe.primaryProbe,
            },
            expectedImpact: "Improved action selection confidence and reduced tree search frequency.",
            autoApplicable: false,
            priority: "high",
          });
          break;

        case "error_pattern":
          suggestions.push({
            type: "add_recovery",
            description: `Add recovery rules for tool failures: ${issue.description}`,
            changes: {
              recoveryRules: issue.affectedSessions.slice(0, 3),
            },
            expectedImpact: "Automated recovery from known failure patterns.",
            autoApplicable: true,
            priority: "high",
          });
          break;

        case "missing_tool":
          suggestions.push({
            type: "add_tool",
            description: issue.description,
            changes: {},
            expectedImpact: "New capabilities to handle currently unsupported requests.",
            autoApplicable: false,
            priority: "medium",
          });
          break;

        case "stagnation":
          suggestions.push({
            type: "config_change",
            description: "Lower stagnation threshold or enable deeper tree search to break out of loops.",
            changes: {
              "treeSearch.maxDepth": 5,
              "recovery.detectFailures": true,
            },
            expectedImpact: "Earlier detection of unproductive loops.",
            autoApplicable: true,
            priority: "medium",
          });
          break;

        case "latency":
          suggestions.push({
            type: "config_change",
            description: "Reduce tree search time budget or switch to direct observation encoder.",
            changes: {
              "treeSearch.timeBudgetMs": 300,
              observationEncoder: "direct",
            },
            expectedImpact: "Lower per-step latency.",
            autoApplicable: true,
            priority: "low",
          });
          break;
      }
    }

    return suggestions.sort((a, b) => {
      const priority = { high: 0, medium: 1, low: 2 };
      return priority[a.priority] - priority[b.priority];
    });
  }

  // -----------------------------------------------------------------------
  // Markdown Report
  // -----------------------------------------------------------------------

  private renderMarkdown(
    input: IterateAgentInput,
    issues: AgentIssue[],
    suggestions: AgentSuggestion[],
    successRate: number,
    avgRating: number | undefined,
    appliedChanges: string[],
  ): string {
    const lines: string[] = [];

    lines.push(`# Iteration Report: ${input.agentId}`);
    lines.push(`**Traces Analyzed:** ${input.traces.length}`);
    lines.push(`**Success Rate:** ${(successRate * 100).toFixed(1)}%`);
    if (avgRating !== undefined) {
      lines.push(`**Avg Rating:** ${avgRating.toFixed(1)}/5`);
    }
    lines.push("");

    if (issues.length > 0) {
      lines.push("## Issues Found");
      for (const issue of issues) {
        lines.push(`- **[${issue.severity.toUpperCase()}]** ${issue.description} (${(issue.frequency * 100).toFixed(0)}% of sessions)`);
      }
      lines.push("");
    }

    if (suggestions.length > 0) {
      lines.push("## Suggestions");
      for (const s of suggestions) {
        const auto = s.autoApplicable ? " [auto-applicable]" : "";
        lines.push(`- **${s.type}** (${s.priority}): ${s.description}${auto}`);
        lines.push(`  Expected impact: ${s.expectedImpact}`);
      }
      lines.push("");
    }

    if (appliedChanges.length > 0) {
      lines.push("## Auto-Applied Changes");
      for (const change of appliedChanges) {
        lines.push(`- ${change}`);
      }
    }

    return lines.join("\n");
  }
}
