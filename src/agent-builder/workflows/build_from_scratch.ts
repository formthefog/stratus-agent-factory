/**
 * Build From Scratch Workflow — End-to-end agent construction
 *
 * Orchestrates the full pipeline: domain analysis → tool registry →
 * tool implementation generation → probe selection → (optional training) →
 * test scenarios → configuration → testing → (fix loop) → deployment.
 *
 * @purpose Orchestrate the full "build agent from scratch" workflow
 * @spec AGENT_FACTORY_SPEC.md#c31-design-the-build-agent-from-scratch-workflow
 */

import type {
  AnalyzeDomainTool,
  AnalyzeDomainInput,
  DomainAnalysis,
  GenerateToolRegistryTool,
  ApiEndpoint,
  ToolRegistryOutput,
  GenerateToolImplementationsTool,
  ImplementationMode,
  IntegrationConfig,
  ToolImplementationsOutput,
  GenerateTestScenariosTool,
  TestSuiteOutput,
  SelectProbeTool,
  ProbeRecommendation,
  TrainProbeTool,
  ProbeTrainingResult,
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

export interface BuildFromScratchInput {
  /** Natural language description of the domain */
  domainDescription: string;
  /** Available API endpoints (optional — if omitted, tools are generated from domain analysis) */
  apis?: ApiEndpoint[];
  /** Agent name */
  agentName: string;
  /** Agent identifier (snake_case) */
  agentId: string;
  /** LLM preferences */
  llm: { provider: string; model: string };
  /** Tool implementation mode (default: "mock" when no apis, "api_client" when apis provided) */
  implementationMode?: ImplementationMode;
  /** Target language for generated tool implementations (default: "typescript") */
  implementationLanguage?: "typescript" | "python";
  /** Integration configs for API-backed tools */
  integrations?: IntegrationConfig[];
  /** Channels to configure */
  channels?: Array<{ type: "slack" | "discord" | "telegram" | "web" | "api"; settings: Record<string, string> }>;
  /** Persona description (optional) */
  personaDescription?: string;
  /** Custom instructions */
  customInstructions?: string;
  /** Example user goals */
  exampleGoals?: string[];
  /** Whether to train a custom probe if recommended */
  allowProbeTraining?: boolean;
  /** Deployment target (null = don't deploy) */
  deployTarget?: DeploymentTarget;
  /** Max fix iterations before giving up (default: 3) */
  maxFixIterations?: number;
  /** Minimum test pass rate to proceed (default: 0.7) */
  minPassRate?: number;
}

export interface BuildProgress {
  phase: WorkflowPhase;
  status: "running" | "complete" | "failed" | "skipped";
  detail?: string;
}

export type WorkflowPhase =
  | "analyze_domain"
  | "generate_tools"
  | "generate_implementations"
  | "select_probe"
  | "train_probe"
  | "generate_tests"
  | "configure_agent"
  | "test_agent"
  | "fix_iteration"
  | "deploy_agent";

export interface BuildResult {
  success: boolean;
  /** Phase where it stopped */
  finalPhase: WorkflowPhase;
  /** All intermediate results */
  domainAnalysis?: DomainAnalysis;
  toolRegistry?: ToolRegistryOutput;
  toolImplementations?: ToolImplementationsOutput;
  probeRecommendation?: ProbeRecommendation;
  probeTraining?: ProbeTrainingResult;
  testSuite?: TestSuiteOutput;
  agentConfig?: AgentConfigOutput;
  testReport?: TestReport;
  deployment?: DeploymentResult;
  /** Fix iterations performed */
  fixIterations: number;
  /** Error if failed */
  error?: string;
  /** Progress log */
  log: BuildProgress[];
}

/** Callback for progress reporting. */
export type ProgressFn = (progress: BuildProgress) => void;

// ---------------------------------------------------------------------------
// Workflow Orchestrator
// ---------------------------------------------------------------------------

export class BuildFromScratchWorkflow {
  private analyzeDomain: AnalyzeDomainTool;
  private generateToolRegistry: GenerateToolRegistryTool;
  private generateToolImplementations: GenerateToolImplementationsTool;
  private generateTestScenarios: GenerateTestScenariosTool;
  private selectProbe: SelectProbeTool;
  private trainProbe: TrainProbeTool;
  private configureAgent: ConfigureAgentTool;
  private testAgent: TestAgentTool;
  private deployAgent: DeployAgentTool;

  constructor(tools: {
    analyzeDomain: AnalyzeDomainTool;
    generateToolRegistry: GenerateToolRegistryTool;
    generateToolImplementations: GenerateToolImplementationsTool;
    generateTestScenarios: GenerateTestScenariosTool;
    selectProbe: SelectProbeTool;
    trainProbe: TrainProbeTool;
    configureAgent: ConfigureAgentTool;
    testAgent: TestAgentTool;
    deployAgent: DeployAgentTool;
  }) {
    this.analyzeDomain = tools.analyzeDomain;
    this.generateToolRegistry = tools.generateToolRegistry;
    this.generateToolImplementations = tools.generateToolImplementations;
    this.generateTestScenarios = tools.generateTestScenarios;
    this.selectProbe = tools.selectProbe;
    this.trainProbe = tools.trainProbe;
    this.configureAgent = tools.configureAgent;
    this.testAgent = tools.testAgent;
    this.deployAgent = tools.deployAgent;
  }

  async execute(
    input: BuildFromScratchInput,
    onProgress?: ProgressFn,
    signal?: AbortSignal,
  ): Promise<BuildResult> {
    const log: BuildProgress[] = [];
    const maxFix = input.maxFixIterations ?? 3;
    const minPass = input.minPassRate ?? 0.7;

    const emit = (p: BuildProgress) => {
      log.push(p);
      onProgress?.(p);
    };

    // ── Step 1: Analyze Domain ──────────────────────────────────────────
    emit({ phase: "analyze_domain", status: "running" });
    let domainAnalysis: DomainAnalysis;
    try {
      const availableApis = input.apis?.map((a) => `${a.method ?? "POST"} ${a.endpoint}: ${a.description}`) ?? [];
      domainAnalysis = await this.analyzeDomain.execute(
        {
          description: input.domainDescription,
          availableApis,
          exampleGoals: input.exampleGoals,
        } satisfies AnalyzeDomainInput,
        signal,
      );
      emit({ phase: "analyze_domain", status: "complete", detail: `${domainAnalysis.actions.length} actions, ${domainAnalysis.workflows.length} workflows` });
    } catch (err) {
      emit({ phase: "analyze_domain", status: "failed", detail: String(err) });
      return { success: false, finalPhase: "analyze_domain", fixIterations: 0, error: String(err), log };
    }

    // Gate: must have at least 1 action
    if (domainAnalysis.actions.length === 0) {
      emit({ phase: "analyze_domain", status: "failed", detail: "No actions extracted" });
      return { success: false, finalPhase: "analyze_domain", fixIterations: 0, error: "Domain analysis produced no actions. Provide more domain detail or example goals.", log, domainAnalysis };
    }

    // ── Step 2: Generate Tool Registry ──────────────────────────────────
    emit({ phase: "generate_tools", status: "running" });
    let toolRegistry: ToolRegistryOutput;
    try {
      toolRegistry = await this.generateToolRegistry.execute(
        { analysis: domainAnalysis, apis: input.apis ?? [] },
        signal,
      );
      emit({ phase: "generate_tools", status: "complete", detail: `${toolRegistry.tools.length} tools, ${toolRegistry.similarityWarnings.length} warnings` });
    } catch (err) {
      emit({ phase: "generate_tools", status: "failed", detail: String(err) });
      return { success: false, finalPhase: "generate_tools", fixIterations: 0, error: String(err), log, domainAnalysis };
    }

    // ── Step 2.5: Generate Tool Implementations ─────────────────────────
    // Determines mode: if APIs provided, default to api_client; otherwise mock
    const implMode = input.implementationMode ?? (input.apis?.length ? "api_client" : "mock");
    const implLanguage = input.implementationLanguage ?? "typescript";

    emit({ phase: "generate_implementations", status: "running", detail: `mode=${implMode}, lang=${implLanguage}` });
    let toolImplementations: ToolImplementationsOutput | undefined;
    try {
      toolImplementations = await this.generateToolImplementations.execute(
        {
          tools: toolRegistry.tools,
          analysis: domainAnalysis,
          mode: implMode,
          language: implLanguage,
          integrations: input.integrations,
        },
        signal,
      );
      emit({ phase: "generate_implementations", status: "complete", detail: `${toolImplementations.totalFiles} files (${implMode})` });
    } catch (err) {
      // Non-fatal for mock/stub — agent can still work with tool definitions alone
      if (implMode === "api_client") {
        emit({ phase: "generate_implementations", status: "failed", detail: String(err) });
        return { success: false, finalPhase: "generate_implementations", fixIterations: 0, error: String(err), log, domainAnalysis, toolRegistry };
      }
      emit({ phase: "generate_implementations", status: "failed", detail: `Non-fatal: ${err}. Continuing with tool definitions only.` });
    }

    // ── Step 3: Select Probe ────────────────────────────────────────────
    emit({ phase: "select_probe", status: "running" });
    let probeRecommendation: ProbeRecommendation;
    try {
      probeRecommendation = await this.selectProbe.execute({
        analysis: domainAnalysis,
        allowCustomTraining: input.allowProbeTraining ?? true,
      });
      emit({ phase: "select_probe", status: "complete", detail: `${probeRecommendation.primaryProbe} (accuracy: ${(probeRecommendation.expectedAccuracy * 100).toFixed(0)}%)` });
    } catch (err) {
      emit({ phase: "select_probe", status: "failed", detail: String(err) });
      return { success: false, finalPhase: "select_probe", fixIterations: 0, error: String(err), log, domainAnalysis, toolRegistry, toolImplementations };
    }

    // ── Step 4: Train Probe (optional) ──────────────────────────────────
    let probeTraining: ProbeTrainingResult | undefined;
    if (probeRecommendation.customTrainingRecommended && input.allowProbeTraining !== false) {
      emit({ phase: "train_probe", status: "running" });
      try {
        probeTraining = await this.trainProbe.execute(
          {
            domain: domainAnalysis.domainName,
            analysis: domainAnalysis,
            tools: toolRegistry.tools,
            baseProbe: probeRecommendation.primaryProbe,
          },
          signal,
        );
        if (probeTraining.passedQualityCheck) {
          probeRecommendation = {
            ...probeRecommendation,
            primaryProbe: probeTraining.probeId,
            expectedAccuracy: probeTraining.metrics.top1Accuracy,
          };
        }
        emit({ phase: "train_probe", status: "complete", detail: `top1=${(probeTraining.metrics.top1Accuracy * 100).toFixed(0)}% quality=${probeTraining.passedQualityCheck ? "pass" : "fail"}` });
      } catch (err) {
        emit({ phase: "train_probe", status: "failed", detail: `Training failed, using ${probeRecommendation.primaryProbe}: ${err}` });
        // Non-fatal — continue with general probe
      }
    } else {
      emit({ phase: "train_probe", status: "skipped" });
    }

    // ── Step 5: Generate Test Scenarios ─────────────────────────────────
    emit({ phase: "generate_tests", status: "running" });
    let testSuite: TestSuiteOutput;
    try {
      testSuite = await this.generateTestScenarios.execute(
        { analysis: domainAnalysis, tools: toolRegistry.tools },
        signal,
      );
      emit({ phase: "generate_tests", status: "complete", detail: `${testSuite.totalScenarios} scenarios` });
    } catch (err) {
      emit({ phase: "generate_tests", status: "failed", detail: String(err) });
      return { success: false, finalPhase: "generate_tests", fixIterations: 0, error: String(err), log, domainAnalysis, toolRegistry, toolImplementations, probeRecommendation, probeTraining };
    }

    // ── Step 6 + 7: Configure → Test → Fix Loop ────────────────────────
    let agentConfig: AgentConfigOutput | undefined;
    let testReport: TestReport | undefined;
    let fixIterations = 0;

    for (let attempt = 0; attempt <= maxFix; attempt++) {
      // Configure
      emit({ phase: attempt === 0 ? "configure_agent" : "fix_iteration", status: "running", detail: attempt > 0 ? `fix iteration ${attempt}` : undefined });
      try {
        agentConfig = await this.configureAgent.execute(
          {
            agentName: input.agentName,
            agentId: input.agentId,
            analysis: domainAnalysis,
            toolRegistry,
            probe: probeRecommendation,
            llm: input.llm,
            channels: input.channels,
            personaDescription: input.personaDescription,
            customInstructions: input.customInstructions,
          },
          signal,
        );
        emit({ phase: "configure_agent", status: "complete", detail: `${agentConfig.files.length} files` });
      } catch (err) {
        emit({ phase: "configure_agent", status: "failed", detail: String(err) });
        return { success: false, finalPhase: "configure_agent", fixIterations, error: String(err), log, domainAnalysis, toolRegistry, toolImplementations, probeRecommendation, probeTraining, testSuite };
      }

      // Test
      emit({ phase: "test_agent", status: "running" });
      try {
        testReport = await this.testAgent.execute(
          { agentConfig, scenarios: testSuite.scenarios },
          signal,
        );
        emit({ phase: "test_agent", status: "complete", detail: `${testReport.passed}/${testReport.totalScenarios} passed (${(testReport.passRate * 100).toFixed(0)}%)` });
      } catch (err) {
        emit({ phase: "test_agent", status: "failed", detail: String(err) });
        return { success: false, finalPhase: "test_agent", fixIterations, error: String(err), log, domainAnalysis, toolRegistry, toolImplementations, probeRecommendation, probeTraining, testSuite, agentConfig };
      }

      // Check pass rate
      if (testReport.passRate >= minPass) {
        break;
      }

      // Need to fix — but only if we have iterations left
      if (attempt < maxFix) {
        fixIterations++;
        emit({ phase: "fix_iteration", status: "running", detail: `Pass rate ${(testReport.passRate * 100).toFixed(0)}% < ${(minPass * 100).toFixed(0)}%. Attempting fix ${fixIterations}/${maxFix}` });
        // In a real implementation, this would analyze failures and adjust
        // tool descriptions, probe config, or agent instructions
        emit({ phase: "fix_iteration", status: "complete" });
      }
    }

    // ── Step 8: Deploy (optional) ───────────────────────────────────────
    let deployment: DeploymentResult | undefined;
    if (input.deployTarget && testReport && testReport.passRate >= minPass) {
      emit({ phase: "deploy_agent", status: "running" });
      try {
        deployment = await this.deployAgent.execute(
          {
            agentConfig: agentConfig!,
            testReport,
            target: input.deployTarget,
          },
          signal,
        );
        emit({ phase: "deploy_agent", status: deployment.success ? "complete" : "failed", detail: deployment.accessUrl ?? deployment.installPath ?? deployment.error });
      } catch (err) {
        emit({ phase: "deploy_agent", status: "failed", detail: String(err) });
      }
    } else if (!input.deployTarget) {
      emit({ phase: "deploy_agent", status: "skipped" });
    }

    const success = testReport != null && testReport.passRate >= minPass;

    return {
      success,
      finalPhase: deployment ? "deploy_agent" : "test_agent",
      domainAnalysis,
      toolRegistry,
      toolImplementations,
      probeRecommendation,
      probeTraining,
      testSuite,
      agentConfig,
      testReport,
      deployment,
      fixIterations,
      error: success ? undefined : `Test pass rate ${((testReport?.passRate ?? 0) * 100).toFixed(0)}% below ${(minPass * 100).toFixed(0)}% after ${fixIterations} fix iterations`,
      log,
    };
  }
}
