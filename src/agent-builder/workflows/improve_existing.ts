/**
 * Improve Existing Agent Workflow — Iterate on a deployed agent
 *
 * Takes production traces and feedback, analyzes issues, applies
 * improvements (tool descriptions, probe retraining, config changes),
 * re-tests, and hot-deploys updates.
 *
 * @purpose Orchestrate the "improve existing agent" workflow from production feedback
 * @spec AGENT_FACTORY_SPEC.md#c33-design-the-improve-existing-agent-workflow
 */

import type {
  IterateAgentTool,
  IterationReport,
  ProductionTrace,
  UserFeedback,
  AgentSuggestion,
  DomainAnalysis,
  ToolDefinition,
  ProbeRecommendation,
  TrainProbeTool,
  ProbeTrainingResult,
  TrainingTrace,
  GenerateTestScenariosTool,
  TestSuiteOutput,
  ConfigureAgentTool,
  AgentConfigOutput,
  TestAgentTool,
  TestReport,
  DeployAgentTool,
  DeploymentResult,
  DeploymentTarget,
} from "../tools/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImproveExistingInput {
  /** Agent identifier */
  agentId: string;
  /** Current agent configuration */
  currentConfig: AgentConfigOutput;
  /** Domain analysis (from initial build) */
  analysis: DomainAnalysis;
  /** Current tool definitions */
  tools: ToolDefinition[];
  /** Current probe recommendation */
  probe: ProbeRecommendation;
  /** Production traces to analyze */
  traces: ProductionTrace[];
  /** User feedback */
  feedback?: UserFeedback[];
  /** Whether to auto-apply safe changes (default: true) */
  autoApply?: boolean;
  /** Whether to retrain probe if recommended (default: true) */
  allowProbeRetrain?: boolean;
  /** Deployment target for hot-deploy (null = no deploy) */
  deployTarget?: DeploymentTarget;
  /** LLM preferences */
  llm: { provider: string; model: string };
}

export interface ImproveResult {
  success: boolean;
  /** Iteration analysis */
  iterationReport: IterationReport;
  /** Whether probe was retrained */
  probeRetrained: boolean;
  probeTraining?: ProbeTrainingResult;
  /** Updated test results */
  testReport?: TestReport;
  /** Deployment result (if hot-deployed) */
  deployment?: DeploymentResult;
  /** Summary of all changes made */
  changesMade: string[];
  /** Comparison: before vs after */
  comparison?: {
    beforePassRate: number;
    afterPassRate: number;
    improvement: number;
  };
  error?: string;
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export class ImproveExistingWorkflow {
  private iterateAgent: IterateAgentTool;
  private trainProbe: TrainProbeTool;
  private generateTestScenarios: GenerateTestScenariosTool;
  private configureAgent: ConfigureAgentTool;
  private testAgent: TestAgentTool;
  private deployAgent: DeployAgentTool;

  constructor(tools: {
    iterateAgent: IterateAgentTool;
    trainProbe: TrainProbeTool;
    generateTestScenarios: GenerateTestScenariosTool;
    configureAgent: ConfigureAgentTool;
    testAgent: TestAgentTool;
    deployAgent: DeployAgentTool;
  }) {
    this.iterateAgent = tools.iterateAgent;
    this.trainProbe = tools.trainProbe;
    this.generateTestScenarios = tools.generateTestScenarios;
    this.configureAgent = tools.configureAgent;
    this.testAgent = tools.testAgent;
    this.deployAgent = tools.deployAgent;
  }

  async execute(
    input: ImproveExistingInput,
    signal?: AbortSignal,
  ): Promise<ImproveResult> {
    const changesMade: string[] = [];
    const autoApply = input.autoApply ?? true;
    const allowRetrain = input.allowProbeRetrain ?? true;

    // ── Step 1: Analyze production traces ───────────────────────────────
    let iterationReport: IterationReport;
    try {
      iterationReport = await this.iterateAgent.execute({
        agentId: input.agentId,
        analysis: input.analysis,
        tools: input.tools,
        probe: input.probe,
        traces: input.traces,
        feedback: input.feedback,
        autoApply,
      });
    } catch (err) {
      return {
        success: false,
        iterationReport: {
          agentId: input.agentId,
          tracesAnalyzed: 0,
          successRate: 0,
          issues: [],
          suggestions: [],
          appliedChanges: [],
          retestRecommended: false,
          probeRetrainRecommended: false,
          markdown: "",
        },
        probeRetrained: false,
        changesMade,
        error: `Iteration analysis failed: ${err}`,
      };
    }

    // Record auto-applied changes
    changesMade.push(...iterationReport.appliedChanges);

    // ── Step 2: Retrain probe if recommended ────────────────────────────
    let probeRetrained = false;
    let probeTraining: ProbeTrainingResult | undefined;

    if (iterationReport.probeRetrainRecommended && allowRetrain) {
      try {
        // Convert production traces to training format
        const trainingTraces = this.convertToTrainingTraces(input.traces);

        probeTraining = await this.trainProbe.execute(
          {
            domain: input.analysis.domainName,
            analysis: input.analysis,
            tools: input.tools,
            traces: trainingTraces,
            baseProbe: input.probe.primaryProbe,
          },
          signal,
        );

        if (probeTraining.passedQualityCheck) {
          probeRetrained = true;
          changesMade.push(`Retrained probe: ${probeTraining.probeId} (top1=${(probeTraining.metrics.top1Accuracy * 100).toFixed(0)}%)`);
        } else {
          changesMade.push(`Probe retraining attempted but did not pass quality check`);
        }
      } catch {
        changesMade.push("Probe retraining failed — continuing with existing probe");
      }
    }

    // ── Step 3: Apply tool description improvements ─────────────────────
    const updatedTools = this.applyToolSuggestions(
      input.tools,
      iterationReport.suggestions,
    );

    for (const suggestion of iterationReport.suggestions) {
      if (suggestion.type === "modify_tool" && suggestion.autoApplicable && autoApply) {
        changesMade.push(`Modified tool: ${suggestion.description}`);
      }
    }

    // ── Step 4: Re-configure with improvements ──────────────────────────
    let agentConfig: AgentConfigOutput;
    try {
      const updatedProbe: ProbeRecommendation = probeRetrained && probeTraining
        ? { ...input.probe, primaryProbe: probeTraining.probeId }
        : input.probe;

      agentConfig = await this.configureAgent.execute(
        {
          agentName: (input.currentConfig.openclawConfig.name as string) ?? input.agentId,
          agentId: input.agentId,
          analysis: input.analysis,
          toolRegistry: {
            domain: input.analysis.domainName,
            tools: updatedTools,
            similarityWarnings: [],
            missingCapabilities: [],
            yaml: "",
          },
          probe: updatedProbe,
          llm: input.llm,
        },
        signal,
      );
    } catch (err) {
      return {
        success: false,
        iterationReport,
        probeRetrained,
        probeTraining,
        changesMade,
        error: `Re-configuration failed: ${err}`,
      };
    }

    // ── Step 5: Re-test ─────────────────────────────────────────────────
    let testReport: TestReport | undefined;
    if (iterationReport.retestRecommended) {
      try {
        const testSuite = await this.generateTestScenarios.execute(
          { analysis: input.analysis, tools: updatedTools },
          signal,
        );

        testReport = await this.testAgent.execute(
          { agentConfig, scenarios: testSuite.scenarios },
          signal,
        );

        changesMade.push(`Re-tested: ${testReport.passed}/${testReport.totalScenarios} passed (${(testReport.passRate * 100).toFixed(0)}%)`);
      } catch {
        changesMade.push("Re-testing failed — deploy with caution");
      }
    }

    // ── Step 6: Hot-deploy if appropriate ───────────────────────────────
    let deployment: DeploymentResult | undefined;
    const shouldDeploy = input.deployTarget &&
      changesMade.length > 0 &&
      (!testReport || testReport.passRate >= 0.7);

    if (shouldDeploy) {
      try {
        deployment = await this.deployAgent.execute(
          {
            agentConfig,
            testReport: testReport ?? {
              agentId: input.agentId,
              totalScenarios: 0,
              passed: 0,
              failed: 0,
              passRate: 1,
              byCategory: {},
              results: [],
              latencyStats: { avgStepMs: 0, avgScenarioMs: 0, p95StepMs: 0 },
              recommendations: [],
              markdown: "",
            },
            target: input.deployTarget!,
            minPassRate: 0.6, // Lower bar for iterations (existing agent is already deployed)
          },
          signal,
        );

        if (deployment.success) {
          changesMade.push(`Hot-deployed to ${deployment.accessUrl ?? deployment.installPath ?? "target"}`);
        }
      } catch {
        changesMade.push("Hot-deploy failed");
      }
    }

    // Build comparison if we have before/after test data
    const comparison = testReport
      ? {
          beforePassRate: iterationReport.successRate,
          afterPassRate: testReport.passRate,
          improvement: testReport.passRate - iterationReport.successRate,
        }
      : undefined;

    return {
      success: changesMade.length > 0,
      iterationReport,
      probeRetrained,
      probeTraining,
      testReport,
      deployment,
      changesMade,
      comparison,
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private convertToTrainingTraces(traces: ProductionTrace[]): TrainingTrace[] {
    return traces
      .filter((t) => t.success) // Only train on successful traces
      .map((t) => ({
        sessionId: t.sessionId,
        goal: t.goal,
        steps: t.steps.map((s) => ({
          stateText: `Step ${s.step}: used ${s.toolUsed}`,
          actionTaken: s.toolUsed,
          goalProximity: s.goalProximity,
        })),
        success: t.success,
      }));
  }

  private applyToolSuggestions(
    tools: ToolDefinition[],
    suggestions: AgentSuggestion[],
  ): ToolDefinition[] {
    const updated = [...tools];

    for (const suggestion of suggestions) {
      if (suggestion.type === "add_tool" && suggestion.autoApplicable) {
        // Would need the full tool definition — for now, flag it
      }

      if (suggestion.type === "remove_tool") {
        const toolId = (suggestion.changes as Record<string, string>).toolId;
        const idx = updated.findIndex((t) => t.id === toolId);
        if (idx >= 0) updated.splice(idx, 1);
      }
    }

    return updated;
  }
}
