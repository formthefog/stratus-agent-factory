/**
 * Test Agent — Runs test scenarios against a configured agent
 *
 * Starts an agent in sandbox mode, runs each test scenario, records
 * actions taken, goal proximity curves, and generates a test report.
 *
 * @purpose Run test scenarios against a configured agent in sandbox mode
 * @spec AGENT_FACTORY_SPEC.md#c17-test_agent-tool
 */

import type {
  TestScenario,
  SimulatedToolResponse,
  SuccessCriterion,
} from "./generate_test_scenarios.js";
import type { AgentConfigOutput } from "./configure_agent.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestAgentInput {
  /** Agent configuration */
  agentConfig: AgentConfigOutput;
  /** Test scenarios to run */
  scenarios: TestScenario[];
  /** Timeout per scenario in ms (default: 30000) */
  scenarioTimeoutMs?: number;
  /** Whether to continue on failure (default: true) */
  continueOnFailure?: boolean;
}

export interface ScenarioResult {
  /** Scenario that was tested */
  scenarioId: string;
  scenarioName: string;
  category: string;
  /** Pass/fail */
  passed: boolean;
  /** Why it failed (if failed) */
  failureReason?: string;
  /** Actions the agent actually took */
  actionsTaken: ActionRecord[];
  /** Goal proximity at each step */
  proximityCurve: number[];
  /** Whether the expected tool sequence was followed */
  sequenceMatch: boolean;
  /** Individual criteria results */
  criteriaResults: CriterionResult[];
  /** Total steps taken */
  totalSteps: number;
  /** Total time in ms */
  totalMs: number;
  /** LLM calls made */
  llmCalls: number;
}

export interface ActionRecord {
  step: number;
  toolId: string;
  parameters: Record<string, unknown>;
  success: boolean;
  output: string;
  latencyMs: number;
}

export interface CriterionResult {
  criterion: SuccessCriterion;
  passed: boolean;
  detail?: string;
}

export interface TestReport {
  /** Agent that was tested */
  agentId: string;
  /** Total scenarios */
  totalScenarios: number;
  /** Passed count */
  passed: number;
  /** Failed count */
  failed: number;
  /** Pass rate */
  passRate: number;
  /** Results by category */
  byCategory: Record<string, { passed: number; total: number }>;
  /** Individual scenario results */
  results: ScenarioResult[];
  /** Overall latency stats */
  latencyStats: {
    avgStepMs: number;
    avgScenarioMs: number;
    p95StepMs: number;
  };
  /** Recommendations based on results */
  recommendations: string[];
  /** Markdown report */
  markdown: string;
}

// ---------------------------------------------------------------------------
// Agent Runner (sandbox interface)
// ---------------------------------------------------------------------------

/**
 * Callback to run a single agent turn in sandbox mode.
 * The test harness provides simulated tool responses.
 */
export type SandboxRunnerFn = (
  agentConfig: AgentConfigOutput,
  messages: Array<{ role: string; content: string }>,
  simulatedResponses: Record<string, SimulatedToolResponse>,
  signal?: AbortSignal,
) => Promise<SandboxTurnResult>;

export interface SandboxTurnResult {
  /** Tool the agent chose */
  toolId: string;
  /** Parameters generated */
  parameters: Record<string, unknown>;
  /** Whether the tool succeeded (from simulated responses) */
  success: boolean;
  /** Tool output */
  output: string;
  /** Current goal proximity */
  goalProximity: number;
  /** Whether the agent considers the goal reached */
  goalReached: boolean;
  /** Latency for this turn */
  latencyMs: number;
  /** Whether an LLM call was made */
  usedLlm: boolean;
  /** Agent's response text (if any) */
  response?: string;
}

// ---------------------------------------------------------------------------
// Tool Implementation
// ---------------------------------------------------------------------------

export class TestAgentTool {
  private runner: SandboxRunnerFn;

  constructor(runner: SandboxRunnerFn) {
    this.runner = runner;
  }

  async execute(
    input: TestAgentInput,
    signal?: AbortSignal,
  ): Promise<TestReport> {
    const timeoutMs = input.scenarioTimeoutMs ?? 30_000;
    const continueOnFailure = input.continueOnFailure ?? true;
    const results: ScenarioResult[] = [];

    for (const scenario of input.scenarios) {
      const result = await this.runScenario(
        input.agentConfig,
        scenario,
        timeoutMs,
        signal,
      );
      results.push(result);

      if (!result.passed && !continueOnFailure) {
        break;
      }
    }

    return this.buildReport(input.agentConfig, results);
  }

  // -----------------------------------------------------------------------
  // Scenario Execution
  // -----------------------------------------------------------------------

  private async runScenario(
    agentConfig: AgentConfigOutput,
    scenario: TestScenario,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ScenarioResult> {
    const actionsTaken: ActionRecord[] = [];
    const proximityCurve: number[] = [];
    let llmCalls = 0;
    const startTime = Date.now();

    const messages = scenario.conversation.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const simResponses = scenario.simulatedResponses ?? this.buildDefaultResponses(scenario);

    try {
      for (let step = 0; step < scenario.maxSteps; step++) {
        // Check timeout
        if (Date.now() - startTime > timeoutMs) {
          return this.buildResult(scenario, actionsTaken, proximityCurve, llmCalls, startTime, {
            passed: false,
            failureReason: `Timeout after ${timeoutMs}ms`,
          });
        }

        // Check abort
        if (signal?.aborted) {
          return this.buildResult(scenario, actionsTaken, proximityCurve, llmCalls, startTime, {
            passed: false,
            failureReason: "Aborted",
          });
        }

        const turnResult = await this.runner(
          agentConfig,
          messages,
          simResponses,
          signal,
        );

        actionsTaken.push({
          step,
          toolId: turnResult.toolId,
          parameters: turnResult.parameters,
          success: turnResult.success,
          output: turnResult.output,
          latencyMs: turnResult.latencyMs,
        });

        proximityCurve.push(turnResult.goalProximity);
        if (turnResult.usedLlm) llmCalls++;

        // Add tool result to conversation for next turn
        messages.push({
          role: "assistant",
          content: turnResult.response ?? `Used ${turnResult.toolId}: ${turnResult.output}`,
        });

        // Check if goal reached
        if (turnResult.goalReached) {
          break;
        }
      }
    } catch (err) {
      return this.buildResult(scenario, actionsTaken, proximityCurve, llmCalls, startTime, {
        passed: false,
        failureReason: `Runtime error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Evaluate criteria
    const criteriaResults = this.evaluateCriteria(scenario, actionsTaken, proximityCurve);
    const allRequired = criteriaResults
      .filter((c) => c.criterion.required)
      .every((c) => c.passed);

    const sequenceMatch = this.checkSequence(
      scenario.expectedToolSequence,
      actionsTaken.map((a) => a.toolId),
    );

    return this.buildResult(scenario, actionsTaken, proximityCurve, llmCalls, startTime, {
      passed: allRequired && sequenceMatch,
      failureReason: allRequired && sequenceMatch ? undefined : "Criteria or sequence mismatch",
      criteriaResults,
      sequenceMatch,
    });
  }

  // -----------------------------------------------------------------------
  // Result Building
  // -----------------------------------------------------------------------

  private buildResult(
    scenario: TestScenario,
    actionsTaken: ActionRecord[],
    proximityCurve: number[],
    llmCalls: number,
    startTime: number,
    extra: {
      passed: boolean;
      failureReason?: string;
      criteriaResults?: CriterionResult[];
      sequenceMatch?: boolean;
    },
  ): ScenarioResult {
    return {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      category: scenario.category,
      passed: extra.passed,
      failureReason: extra.failureReason,
      actionsTaken,
      proximityCurve,
      sequenceMatch: extra.sequenceMatch ?? false,
      criteriaResults: extra.criteriaResults ?? [],
      totalSteps: actionsTaken.length,
      totalMs: Date.now() - startTime,
      llmCalls,
    };
  }

  // -----------------------------------------------------------------------
  // Criteria Evaluation
  // -----------------------------------------------------------------------

  private evaluateCriteria(
    scenario: TestScenario,
    actions: ActionRecord[],
    proximity: number[],
  ): CriterionResult[] {
    return scenario.successCriteria.map((criterion) => {
      switch (criterion.type) {
        case "tool_called":
          return {
            criterion,
            passed: actions.some((a) => a.toolId === criterion.value),
            detail: actions.some((a) => a.toolId === criterion.value)
              ? `Tool "${criterion.value}" was called`
              : `Tool "${criterion.value}" was never called`,
          };

        case "tool_not_called":
          return {
            criterion,
            passed: !actions.some((a) => a.toolId === criterion.value),
            detail: actions.some((a) => a.toolId === criterion.value)
              ? `Tool "${criterion.value}" was called (forbidden)`
              : `Tool "${criterion.value}" was correctly avoided`,
          };

        case "goal_reached":
          return {
            criterion,
            passed: proximity.length > 0 && proximity[proximity.length - 1] >= 0.85,
            detail: `Final proximity: ${(proximity[proximity.length - 1] ?? 0).toFixed(2)}`,
          };

        case "output_contains":
          return {
            criterion,
            passed: actions.some((a) =>
              a.output.toLowerCase().includes(criterion.value.toLowerCase()),
            ),
          };

        case "steps_within": {
          const maxSteps = parseInt(criterion.value, 10);
          return {
            criterion,
            passed: actions.length <= maxSteps,
            detail: `${actions.length} steps (limit: ${maxSteps})`,
          };
        }

        default:
          return { criterion, passed: false, detail: "Unknown criterion type" };
      }
    });
  }

  private checkSequence(expected: string[], actual: string[]): boolean {
    if (expected.length === 0) return true;

    let expectedIdx = 0;
    for (const action of actual) {
      if (action === expected[expectedIdx]) {
        expectedIdx++;
        if (expectedIdx >= expected.length) return true;
      }
    }

    return expectedIdx >= expected.length;
  }

  // -----------------------------------------------------------------------
  // Default Simulated Responses
  // -----------------------------------------------------------------------

  private buildDefaultResponses(
    scenario: TestScenario,
  ): Record<string, SimulatedToolResponse> {
    const responses: Record<string, SimulatedToolResponse> = {};

    for (const toolId of scenario.expectedToolSequence) {
      if (!responses[toolId]) {
        responses[toolId] = {
          success: scenario.expectedOutcome !== "graceful_failure",
          output: `Simulated success for ${toolId}`,
        };
      }
    }

    return responses;
  }

  // -----------------------------------------------------------------------
  // Report Generation
  // -----------------------------------------------------------------------

  private buildReport(
    agentConfig: AgentConfigOutput,
    results: ScenarioResult[],
  ): TestReport {
    const passed = results.filter((r) => r.passed).length;
    const failed = results.length - passed;

    // By category
    const byCategory: Record<string, { passed: number; total: number }> = {};
    for (const r of results) {
      const cat = byCategory[r.category] ?? { passed: 0, total: 0 };
      cat.total++;
      if (r.passed) cat.passed++;
      byCategory[r.category] = cat;
    }

    // Latency stats
    const allStepMs = results.flatMap((r) => r.actionsTaken.map((a) => a.latencyMs));
    const sortedMs = [...allStepMs].sort((a, b) => a - b);

    const latencyStats = {
      avgStepMs: allStepMs.length > 0
        ? allStepMs.reduce((a, b) => a + b, 0) / allStepMs.length
        : 0,
      avgScenarioMs: results.length > 0
        ? results.reduce((a, r) => a + r.totalMs, 0) / results.length
        : 0,
      p95StepMs: sortedMs.length > 0
        ? sortedMs[Math.floor(sortedMs.length * 0.95)]
        : 0,
    };

    // Recommendations
    const recommendations = this.generateRecommendations(results, byCategory);

    // Markdown report
    const markdown = this.renderMarkdown(
      agentConfig,
      results,
      passed,
      failed,
      byCategory,
      latencyStats,
      recommendations,
    );

    const agentId = (agentConfig.openclawConfig.id as string) ?? "unknown";

    return {
      agentId,
      totalScenarios: results.length,
      passed,
      failed,
      passRate: results.length > 0 ? passed / results.length : 0,
      byCategory,
      results,
      latencyStats,
      recommendations,
      markdown,
    };
  }

  private generateRecommendations(
    results: ScenarioResult[],
    byCategory: Record<string, { passed: number; total: number }>,
  ): string[] {
    const recs: string[] = [];

    const failedResults = results.filter((r) => !r.passed);

    // Check failure patterns
    if ((byCategory["failure"]?.passed ?? 0) === 0 && (byCategory["failure"]?.total ?? 0) > 0) {
      recs.push("All failure scenarios failed — improve error recovery configuration.");
    }

    if ((byCategory["ambiguous"]?.passed ?? 0) === 0 && (byCategory["ambiguous"]?.total ?? 0) > 0) {
      recs.push("All ambiguous scenarios failed — consider enabling tree search or lowering ambiguity threshold.");
    }

    // Check for common tool failures
    const toolFailures = new Map<string, number>();
    for (const r of failedResults) {
      for (const a of r.actionsTaken) {
        if (!a.success) {
          toolFailures.set(a.toolId, (toolFailures.get(a.toolId) ?? 0) + 1);
        }
      }
    }
    for (const [tool, count] of toolFailures) {
      if (count >= 2) {
        recs.push(`Tool "${tool}" failed in ${count} scenarios — check configuration.`);
      }
    }

    // Step efficiency
    const avgSteps = results.reduce((a, r) => a + r.totalSteps, 0) / Math.max(results.length, 1);
    if (avgSteps > 10) {
      recs.push(`Average ${avgSteps.toFixed(1)} steps per scenario — consider training a custom probe for better action selection.`);
    }

    return recs;
  }

  private renderMarkdown(
    agentConfig: AgentConfigOutput,
    results: ScenarioResult[],
    passed: number,
    failed: number,
    byCategory: Record<string, { passed: number; total: number }>,
    latencyStats: { avgStepMs: number; avgScenarioMs: number; p95StepMs: number },
    recommendations: string[],
  ): string {
    const lines: string[] = [];
    const agentId = (agentConfig.openclawConfig.id as string) ?? "unknown";

    lines.push(`# Test Report: ${agentId}`);
    lines.push(`**Date:** ${new Date().toISOString()}`);
    lines.push(`**Pass Rate:** ${passed}/${results.length} (${((passed / Math.max(results.length, 1)) * 100).toFixed(0)}%)`);
    lines.push("");

    lines.push("## Results by Category");
    for (const [cat, stats] of Object.entries(byCategory)) {
      const pct = ((stats.passed / Math.max(stats.total, 1)) * 100).toFixed(0);
      lines.push(`- **${cat}:** ${stats.passed}/${stats.total} (${pct}%)`);
    }
    lines.push("");

    lines.push("## Latency");
    lines.push(`- Avg step: ${latencyStats.avgStepMs.toFixed(0)}ms`);
    lines.push(`- Avg scenario: ${latencyStats.avgScenarioMs.toFixed(0)}ms`);
    lines.push(`- P95 step: ${latencyStats.p95StepMs.toFixed(0)}ms`);
    lines.push("");

    if (failed > 0) {
      lines.push("## Failed Scenarios");
      for (const r of results.filter((r) => !r.passed)) {
        lines.push(`- **${r.scenarioName}** (${r.category}): ${r.failureReason ?? "criteria not met"}`);
      }
      lines.push("");
    }

    if (recommendations.length > 0) {
      lines.push("## Recommendations");
      for (const rec of recommendations) {
        lines.push(`- ${rec}`);
      }
    }

    return lines.join("\n");
  }
}
