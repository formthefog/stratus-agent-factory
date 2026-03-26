/**
 * Deploy Module barrel
 *
 * @purpose Re-export all deployment targets and orchestration
 */

// Local deployment (D.2.1)
export { LocalDeployer } from "./LocalDeployer.js";
export type { LocalDeployOptions, LocalDeployResult } from "./LocalDeployer.js";

// Docker deployment (D.2.2)
export { DockerDeployer } from "./DockerDeployer.js";
export type { DockerDeployOptions, DockerDeployResult } from "./DockerDeployer.js";

// Fly.io deployment (D.2.3)
export { FlyDeployer } from "./FlyDeployer.js";
export type { FlyDeployOptions, FlyDeployResult } from "./FlyDeployer.js";

// Multi-agent orchestration (D.2.4)
export { MultiAgentOrchestrator } from "./MultiAgentOrchestrator.js";
export type {
  OrchestratorConfig,
  AgentSlot,
  RoutingRule,
  OrchestratorStatus,
  AgentStatus,
  SharedCacheInfo,
} from "./MultiAgentOrchestrator.js";
