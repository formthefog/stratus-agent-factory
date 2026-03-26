/**
 * Agent Builder Tools — The 9 tools used by the Agent Builder Agent
 *
 * @purpose Public API for Agent Builder tool implementations
 */

// C.1.1 — Analyze Domain
export { AnalyzeDomainTool } from "./analyze_domain.js";
export type {
  AnalyzeDomainInput,
  DomainAnalysis,
  DomainEntity,
  DomainAction,
  DomainWorkflow,
  TrainingDomainMatch,
  AnalyzeLlmFn,
} from "./analyze_domain.js";

// C.1.2 — Generate Tool Registry
export { GenerateToolRegistryTool } from "./generate_tool_registry.js";
export type {
  GenerateToolRegistryInput,
  ApiEndpoint,
  ToolDefinition,
  ToolParameter,
  ToolRegistryOutput,
  SimilarityWarning,
  GenerateLlmFn,
} from "./generate_tool_registry.js";

// C.1.3 — Generate Test Scenarios
export { GenerateTestScenariosTool } from "./generate_test_scenarios.js";
export type {
  GenerateTestScenariosInput,
  TestScenario,
  ConversationMessage,
  SuccessCriterion,
  SimulatedToolResponse,
  TestSuiteOutput,
  ScenarioLlmFn,
} from "./generate_test_scenarios.js";

// C.1.4 — Select Probe
export { SelectProbeTool } from "./select_probe.js";
export type {
  SelectProbeInput,
  ProbeInfo,
  ProbeRecommendation,
} from "./select_probe.js";

// C.1.5 — Train Probe
export { TrainProbeTool } from "./train_probe.js";
export type {
  TrainProbeInput,
  TrainingTrace,
  TraceStep,
  ProbeTrainingConfig,
  ProbeTrainingResult,
  ProbeMetrics,
  SyntheticLlmFn,
} from "./train_probe.js";

// C.1.6 — Configure Agent
export { ConfigureAgentTool } from "./configure_agent.js";
export type {
  ConfigureAgentInput,
  ChannelConfig,
  AgentConfigOutput,
  GeneratedFile,
  ConfigureLlmFn,
} from "./configure_agent.js";

// C.1.7 — Test Agent
export { TestAgentTool } from "./test_agent.js";
export type {
  TestAgentInput,
  ScenarioResult,
  ActionRecord,
  CriterionResult,
  TestReport,
  SandboxRunnerFn,
  SandboxTurnResult,
} from "./test_agent.js";

// C.1.8 — Deploy Agent
export { DeployAgentTool } from "./deploy_agent.js";
export type {
  DeployAgentInput,
  DeploymentTarget,
  LocalDeployment,
  DockerDeployment,
  CloudDeployment,
  DeploymentResult,
  SmokeTestResult,
  DeploymentArtifact,
  ExecFn,
} from "./deploy_agent.js";

// C.1.9 — Iterate Agent
export { IterateAgentTool } from "./iterate_agent.js";
export type {
  IterateAgentInput,
  ProductionTrace,
  ProductionStep,
  UserFeedback,
  IterationReport,
  AgentIssue,
  AgentSuggestion,
} from "./iterate_agent.js";
