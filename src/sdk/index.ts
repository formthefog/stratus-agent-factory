/**
 * SDK Module barrel
 *
 * @purpose Public API for the AI Transformation product integration
 */

// Primary integration (F.2.1)
export { StratusAgent } from "./StratusAgent.js";
export type {
  AgentConfig,
  ToolInput,
  LLMConfig,
  AgentBuildResult,
  AgentDeployResult,
  AgentStatus,
} from "./StratusAgent.js";

// Transformation Bridge (product integration)
export { TransformationBridge } from "./TransformationBridge.js";
export type {
  TransformationOutput,
  WorkflowSpec,
  ExistingToolSpec,
  BuildStatusUpdate,
  BuildPhase,
} from "./TransformationBridge.js";

// Tool helpers (F.2.2)
export {
  defineTool,
  toToolRegistryYaml,
  validateToolSeparation,
  apiEndpointToTool,
} from "./ToolDefinitionHelpers.js";
export type {
  ToolDefinitionInput,
  ToolRegistryEntry,
} from "./ToolDefinitionHelpers.js";

// CLI (F.1)
export { commands, runCLI } from "./cli.js";
export type { CLICommand, CLIArg } from "./cli.js";
