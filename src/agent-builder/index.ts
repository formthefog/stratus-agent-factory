/**
 * Agent Builder Module — Meta-agent that builds other Stratus agents
 *
 * @purpose Public API for the Agent Builder Agent's tools and types
 */

export {
  // Tools
  AnalyzeDomainTool,
  GenerateToolRegistryTool,
  GenerateTestScenariosTool,
  SelectProbeTool,
  TrainProbeTool,
  ConfigureAgentTool,
  TestAgentTool,
  DeployAgentTool,
  IterateAgentTool,
} from "./tools/index.js";

// Re-export key types that consumers need
export type {
  DomainAnalysis,
  ToolDefinition,
  ToolRegistryOutput,
  TestScenario,
  TestSuiteOutput,
  ProbeRecommendation,
  ProbeTrainingResult,
  AgentConfigOutput,
  TestReport,
  DeploymentResult,
  IterationReport,
} from "./tools/index.js";

// Workflows (C.3)
export {
  BuildFromScratchWorkflow,
  CloneAndCustomizeWorkflow,
  ImproveExistingWorkflow,
} from "./workflows/index.js";
export type {
  BuildFromScratchInput,
  BuildResult,
  BuildProgress,
  WorkflowPhase,
  CloneAndCustomizeInput,
  CloneResult,
  ChangeSummary,
  ImproveExistingInput,
  ImproveResult,
} from "./workflows/index.js";

// Templates (C.4)
export { TemplateManager } from "./templates/index.js";
export type {
  AgentTemplate,
  TemplateFile,
  TemplateMeta,
  TemplateMatch,
} from "./templates/index.js";
