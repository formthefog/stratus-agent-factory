/**
 * Generate Test Scenarios — Creates test suites for agent validation
 *
 * Takes a domain analysis + tool registry and generates 10-20 representative
 * test scenarios covering happy paths, edge cases, and failure modes.
 *
 * @purpose Generate test scenarios for validating agent behavior
 * @spec AGENT_FACTORY_SPEC.md#c13-generate_test_scenarios-tool
 */

import type { DomainAnalysis } from "./analyze_domain.js";
import type { ToolDefinition } from "./generate_tool_registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenerateTestScenariosInput {
  /** Domain analysis */
  analysis: DomainAnalysis;
  /** Tool registry */
  tools: ToolDefinition[];
  /** Number of scenarios to generate (default: 15) */
  count?: number;
  /** Include failure scenarios (default: true) */
  includeFailures?: boolean;
}

export interface TestScenario {
  /** Scenario identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Category of test */
  category: "happy_path" | "edge_case" | "failure" | "multi_step" | "ambiguous";
  /** The user's goal for this scenario */
  goal: string;
  /** Simulated conversation messages */
  conversation: ConversationMessage[];
  /** Expected tool sequence (ordered) */
  expectedToolSequence: string[];
  /** Tools that should NOT be called */
  forbiddenTools?: string[];
  /** Success criteria */
  successCriteria: SuccessCriterion[];
  /** Maximum allowed steps */
  maxSteps: number;
  /** Expected outcome */
  expectedOutcome: "success" | "partial" | "graceful_failure";
  /** Description of what we're testing */
  testingFor: string;
  /** Simulated tool responses (for sandbox mode) */
  simulatedResponses?: Record<string, SimulatedToolResponse>;
}

export interface ConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface SuccessCriterion {
  type: "tool_called" | "tool_not_called" | "goal_reached" | "output_contains" | "steps_within";
  /** Tool ID or text to match */
  value: string;
  /** Whether this criterion is required or optional */
  required: boolean;
}

export interface SimulatedToolResponse {
  success: boolean;
  output: string;
  /** Delay to simulate (ms) */
  delayMs?: number;
}

export interface TestSuiteOutput {
  domain: string;
  totalScenarios: number;
  byCategory: Record<string, number>;
  scenarios: TestScenario[];
  /** JSON manifest for test runner */
  manifest: string;
}

// ---------------------------------------------------------------------------
// LLM Callback
// ---------------------------------------------------------------------------

export type ScenarioLlmFn = (prompt: string, signal?: AbortSignal) => Promise<string>;

// ---------------------------------------------------------------------------
// Tool Implementation
// ---------------------------------------------------------------------------

export class GenerateTestScenariosTool {
  private llm: ScenarioLlmFn;

  constructor(llm: ScenarioLlmFn) {
    this.llm = llm;
  }

  async execute(
    input: GenerateTestScenariosInput,
    signal?: AbortSignal,
  ): Promise<TestSuiteOutput> {
    const count = input.count ?? 15;
    const includeFailures = input.includeFailures ?? true;

    // Determine category distribution
    const distribution = this.planDistribution(count, includeFailures);

    // Generate scenarios per category
    const scenarios: TestScenario[] = [];

    for (const [category, n] of Object.entries(distribution)) {
      const batch = await this.generateCategory(
        category as TestScenario["category"],
        n,
        input.analysis,
        input.tools,
        signal,
      );
      scenarios.push(...batch);
    }

    // Assign IDs
    for (let i = 0; i < scenarios.length; i++) {
      scenarios[i].id = `${input.analysis.domainName}-${String(i + 1).padStart(3, "0")}`;
    }

    const byCategory: Record<string, number> = {};
    for (const s of scenarios) {
      byCategory[s.category] = (byCategory[s.category] ?? 0) + 1;
    }

    return {
      domain: input.analysis.domainName,
      totalScenarios: scenarios.length,
      byCategory,
      scenarios,
      manifest: JSON.stringify({ domain: input.analysis.domainName, scenarios }, null, 2),
    };
  }

  // -----------------------------------------------------------------------
  // Distribution Planning
  // -----------------------------------------------------------------------

  private planDistribution(
    count: number,
    includeFailures: boolean,
  ): Record<string, number> {
    if (!includeFailures) {
      return {
        happy_path: Math.ceil(count * 0.5),
        multi_step: Math.ceil(count * 0.3),
        edge_case: Math.floor(count * 0.2),
      };
    }

    return {
      happy_path: Math.ceil(count * 0.3),
      multi_step: Math.ceil(count * 0.25),
      edge_case: Math.ceil(count * 0.15),
      failure: Math.ceil(count * 0.15),
      ambiguous: Math.floor(count * 0.15),
    };
  }

  // -----------------------------------------------------------------------
  // Category Generation
  // -----------------------------------------------------------------------

  private async generateCategory(
    category: TestScenario["category"],
    count: number,
    analysis: DomainAnalysis,
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): Promise<TestScenario[]> {
    const toolList = tools.map((t) => `- ${t.id}: ${t.description}`).join("\n");
    const goalList = analysis.goals.map((g) => `- ${g}`).join("\n");
    const workflowList = analysis.workflows
      .map((w) => `- ${w.name}: ${w.steps.join(" → ")}`)
      .join("\n");

    const categoryInstructions: Record<string, string> = {
      happy_path: "Generate straightforward scenarios where the user has a clear goal and the tools can accomplish it directly. Expected outcome: success.",
      multi_step: "Generate scenarios requiring 3+ tool calls in sequence. Use the workflow definitions as guides. Expected outcome: success.",
      edge_case: "Generate scenarios with unusual inputs, boundary conditions, or uncommon combinations of tools. Test that the agent handles them gracefully.",
      failure: "Generate scenarios where a tool call FAILS (returns an error). The agent should detect the failure and either retry, use an alternative, or gracefully report the issue. Include simulatedResponses with success=false.",
      ambiguous: "Generate scenarios where the user's goal is vague or could be interpreted multiple ways. The agent should ask for clarification or make a reasonable choice. Include multiple plausible tool sequences.",
    };

    const prompt = [
      `Generate ${count} test scenarios for a "${analysis.domainName}" agent.`,
      `Category: ${category}`,
      ``,
      `## Instructions`,
      categoryInstructions[category],
      ``,
      `## Available Tools`,
      toolList,
      ``,
      `## Common Goals`,
      goalList,
      ``,
      `## Workflows`,
      workflowList,
      ``,
      `## Output Format (JSON array)`,
      `Each scenario:`,
      `{`,
      `  "name": "short descriptive name",`,
      `  "goal": "the user's goal statement",`,
      `  "conversation": [{"role": "user", "content": "..."}],`,
      `  "expectedToolSequence": ["tool_id_1", "tool_id_2"],`,
      `  "successCriteria": [{"type": "tool_called", "value": "tool_id", "required": true}],`,
      `  "maxSteps": 5,`,
      `  "expectedOutcome": "success|partial|graceful_failure",`,
      `  "testingFor": "what aspect this tests"`,
      category === "failure" ? `  "simulatedResponses": {"tool_id": {"success": false, "output": "error message"}}` : "",
      `}`,
    ].filter(Boolean).join("\n");

    const raw = await this.llm(prompt, signal);
    return this.parseScenarios(raw, category);
  }

  // -----------------------------------------------------------------------
  // Parsing
  // -----------------------------------------------------------------------

  private parseScenarios(raw: string, category: TestScenario["category"]): TestScenario[] {
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, raw];
    const jsonStr = (jsonMatch[1] ?? raw).trim();

    try {
      const parsed = JSON.parse(jsonStr);
      const arr = Array.isArray(parsed) ? parsed : [parsed];

      return arr.map((s: Record<string, unknown>) => ({
        id: "",
        name: (s.name as string) ?? "unnamed",
        category,
        goal: (s.goal as string) ?? "",
        conversation: (s.conversation as ConversationMessage[]) ?? [
          { role: "user" as const, content: (s.goal as string) ?? "" },
        ],
        expectedToolSequence: (s.expectedToolSequence as string[]) ?? [],
        forbiddenTools: s.forbiddenTools as string[] | undefined,
        successCriteria: (s.successCriteria as SuccessCriterion[]) ?? [],
        maxSteps: (s.maxSteps as number) ?? 10,
        expectedOutcome: (s.expectedOutcome as TestScenario["expectedOutcome"]) ?? "success",
        testingFor: (s.testingFor as string) ?? category,
        simulatedResponses: s.simulatedResponses as Record<string, SimulatedToolResponse> | undefined,
      }));
    } catch {
      return [];
    }
  }
}
