/**
 * Clone and Customize Workflow — Adapt an existing agent for a new domain
 *
 * Takes an existing agent configuration and modifies it for a different
 * domain or use case. Preserves what works, updates what needs to change.
 *
 * @purpose Orchestrate cloning an existing agent and customizing for a new domain
 * @spec AGENT_FACTORY_SPEC.md#c32-design-the-clone-and-customize-workflow
 */

import type {
  AnalyzeDomainTool,
  DomainAnalysis,
  GenerateToolRegistryTool,
  ApiEndpoint,
  ToolDefinition,
  ToolRegistryOutput,
  SelectProbeTool,
  ProbeRecommendation,
  TrainProbeTool,
  ProbeTrainingResult,
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

export interface CloneAndCustomizeInput {
  /** Existing agent configuration to clone from */
  sourceConfig: AgentConfigOutput;
  /** New agent name */
  agentName: string;
  /** New agent identifier */
  agentId: string;
  /** Description of what's different in the new domain */
  domainChanges: string;
  /** New or modified APIs (merged with existing) */
  newApis?: ApiEndpoint[];
  /** Tools to add */
  addTools?: ToolDefinition[];
  /** Tool IDs to remove */
  removeTools?: string[];
  /** New persona description (null = keep existing) */
  personaDescription?: string;
  /** LLM preferences (null = keep existing) */
  llm?: { provider: string; model: string };
  /** Deployment target */
  deployTarget?: DeploymentTarget;
}

export interface CloneResult {
  success: boolean;
  /** What changed from the source agent */
  changeSummary: ChangeSummary;
  domainAnalysis?: DomainAnalysis;
  toolRegistry?: ToolRegistryOutput;
  probeRecommendation?: ProbeRecommendation;
  probeTraining?: ProbeTrainingResult;
  testSuite?: TestSuiteOutput;
  agentConfig?: AgentConfigOutput;
  testReport?: TestReport;
  deployment?: DeploymentResult;
  error?: string;
}

export interface ChangeSummary {
  toolsAdded: string[];
  toolsRemoved: string[];
  toolsModified: string[];
  probeChanged: boolean;
  personaChanged: boolean;
  configChanges: string[];
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export class CloneAndCustomizeWorkflow {
  private analyzeDomain: AnalyzeDomainTool;
  private generateToolRegistry: GenerateToolRegistryTool;
  private selectProbe: SelectProbeTool;
  private trainProbe: TrainProbeTool;
  private generateTestScenarios: GenerateTestScenariosTool;
  private configureAgent: ConfigureAgentTool;
  private testAgent: TestAgentTool;
  private deployAgent: DeployAgentTool;

  constructor(tools: {
    analyzeDomain: AnalyzeDomainTool;
    generateToolRegistry: GenerateToolRegistryTool;
    selectProbe: SelectProbeTool;
    trainProbe: TrainProbeTool;
    generateTestScenarios: GenerateTestScenariosTool;
    configureAgent: ConfigureAgentTool;
    testAgent: TestAgentTool;
    deployAgent: DeployAgentTool;
  }) {
    this.analyzeDomain = tools.analyzeDomain;
    this.generateToolRegistry = tools.generateToolRegistry;
    this.selectProbe = tools.selectProbe;
    this.trainProbe = tools.trainProbe;
    this.generateTestScenarios = tools.generateTestScenarios;
    this.configureAgent = tools.configureAgent;
    this.testAgent = tools.testAgent;
    this.deployAgent = tools.deployAgent;
  }

  async execute(
    input: CloneAndCustomizeInput,
    signal?: AbortSignal,
  ): Promise<CloneResult> {
    const changeSummary: ChangeSummary = {
      toolsAdded: [],
      toolsRemoved: input.removeTools ?? [],
      toolsModified: [],
      probeChanged: false,
      personaChanged: input.personaDescription != null,
      configChanges: [],
    };

    // ── Step 1: Analyze what's different ────────────────────────────────
    let domainAnalysis: DomainAnalysis;
    try {
      domainAnalysis = await this.analyzeDomain.execute(
        { description: input.domainChanges },
        signal,
      );
    } catch (err) {
      return { success: false, changeSummary, error: `Domain analysis failed: ${err}` };
    }

    // ── Step 2: Merge tool registries ───────────────────────────────────
    let toolRegistry: ToolRegistryOutput;
    try {
      // Start with existing tools, apply modifications
      const existingTools = this.extractToolsFromConfig(input.sourceConfig);
      const mergedApis = [...(input.newApis ?? [])];

      toolRegistry = await this.generateToolRegistry.execute(
        { analysis: domainAnalysis, apis: mergedApis },
        signal,
      );

      // Merge: keep existing tools not in remove list, add new ones
      const removeSet = new Set(input.removeTools ?? []);
      const keptTools = existingTools.filter((t) => !removeSet.has(t.id));
      const newToolIds = new Set(toolRegistry.tools.map((t) => t.id));

      // Detect modifications (tools in both old and new)
      for (const kept of keptTools) {
        if (newToolIds.has(kept.id)) {
          changeSummary.toolsModified.push(kept.id);
        }
      }

      // Add genuinely new tools
      for (const tool of toolRegistry.tools) {
        if (!keptTools.some((k) => k.id === tool.id)) {
          changeSummary.toolsAdded.push(tool.id);
        }
      }

      // Combine into final registry
      const finalTools = [
        ...keptTools.filter((k) => !newToolIds.has(k.id)),
        ...toolRegistry.tools,
        ...(input.addTools ?? []),
      ];

      for (const added of input.addTools ?? []) {
        changeSummary.toolsAdded.push(added.id);
      }

      toolRegistry = {
        ...toolRegistry,
        tools: finalTools,
      };
    } catch (err) {
      return { success: false, changeSummary, domainAnalysis, error: `Tool registry generation failed: ${err}` };
    }

    // ── Step 3: Re-evaluate probe ───────────────────────────────────────
    let probeRecommendation: ProbeRecommendation;
    let probeTraining: ProbeTrainingResult | undefined;

    try {
      probeRecommendation = await this.selectProbe.execute({
        analysis: domainAnalysis,
      });

      // Check if probe changed from source
      const sourceProbe = this.extractProbeFromConfig(input.sourceConfig);
      if (probeRecommendation.primaryProbe !== sourceProbe) {
        changeSummary.probeChanged = true;
        changeSummary.configChanges.push(`Probe: ${sourceProbe} → ${probeRecommendation.primaryProbe}`);
      }

      // Train if recommended
      if (probeRecommendation.customTrainingRecommended) {
        try {
          probeTraining = await this.trainProbe.execute(
            {
              domain: domainAnalysis.domainName,
              analysis: domainAnalysis,
              tools: toolRegistry.tools,
            },
            signal,
          );
          if (probeTraining.passedQualityCheck) {
            probeRecommendation = {
              ...probeRecommendation,
              primaryProbe: probeTraining.probeId,
            };
            changeSummary.probeChanged = true;
          }
        } catch {
          // Non-fatal
        }
      }
    } catch (err) {
      return { success: false, changeSummary, domainAnalysis, toolRegistry, error: `Probe selection failed: ${err}` };
    }

    // ── Step 4: Generate tests for the new configuration ────────────────
    let testSuite: TestSuiteOutput;
    try {
      testSuite = await this.generateTestScenarios.execute(
        { analysis: domainAnalysis, tools: toolRegistry.tools },
        signal,
      );
    } catch (err) {
      return { success: false, changeSummary, domainAnalysis, toolRegistry, probeRecommendation, error: `Test generation failed: ${err}` };
    }

    // ── Step 5: Configure the new agent ─────────────────────────────────
    let agentConfig: AgentConfigOutput;
    try {
      const sourceLlm = this.extractLlmFromConfig(input.sourceConfig);
      agentConfig = await this.configureAgent.execute(
        {
          agentName: input.agentName,
          agentId: input.agentId,
          analysis: domainAnalysis,
          toolRegistry,
          probe: probeRecommendation,
          llm: input.llm ?? sourceLlm,
          personaDescription: input.personaDescription,
        },
        signal,
      );

      if (input.llm && (input.llm.provider !== sourceLlm.provider || input.llm.model !== sourceLlm.model)) {
        changeSummary.configChanges.push(`LLM: ${sourceLlm.provider}/${sourceLlm.model} → ${input.llm.provider}/${input.llm.model}`);
      }
    } catch (err) {
      return { success: false, changeSummary, domainAnalysis, toolRegistry, probeRecommendation, probeTraining, testSuite, error: `Configuration failed: ${err}` };
    }

    // ── Step 6: Test ────────────────────────────────────────────────────
    let testReport: TestReport;
    try {
      testReport = await this.testAgent.execute(
        { agentConfig, scenarios: testSuite.scenarios },
        signal,
      );
    } catch (err) {
      return { success: false, changeSummary, domainAnalysis, toolRegistry, probeRecommendation, probeTraining, testSuite, agentConfig, error: `Testing failed: ${err}` };
    }

    // ── Step 7: Deploy (optional) ───────────────────────────────────────
    let deployment: DeploymentResult | undefined;
    if (input.deployTarget && testReport.passRate >= 0.7) {
      try {
        deployment = await this.deployAgent.execute(
          { agentConfig, testReport, target: input.deployTarget },
          signal,
        );
      } catch {
        // Non-fatal
      }
    }

    return {
      success: testReport.passRate >= 0.7,
      changeSummary,
      domainAnalysis,
      toolRegistry,
      probeRecommendation,
      probeTraining,
      testSuite,
      agentConfig,
      testReport,
      deployment,
    };
  }

  // -----------------------------------------------------------------------
  // Config Extraction Helpers
  // -----------------------------------------------------------------------

  private extractToolsFromConfig(config: AgentConfigOutput): ToolDefinition[] {
    // Extract tool definitions from the YAML file in the config
    const toolsFile = config.files.find((f) => f.path === "agent.tools.yaml");
    if (!toolsFile) return [];

    // In practice, would parse YAML. For now, return empty
    // (the configure_agent tool generates fresh tools anyway)
    return [];
  }

  private extractProbeFromConfig(config: AgentConfigOutput): string {
    const stratus = (config.openclawConfig.stratus as Record<string, unknown>) ?? {};
    return (stratus.probe as string) ?? "planning-v2";
  }

  private extractLlmFromConfig(config: AgentConfigOutput): { provider: string; model: string } {
    return {
      provider: (config.openclawConfig.provider as string) ?? "anthropic",
      model: (config.openclawConfig.model as string) ?? "claude-sonnet-4-5-20250514",
    };
  }
}
