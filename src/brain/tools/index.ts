/**
 * Tool Registry Module — Bridges OpenClaw plugin tools to IBrain
 *
 * @purpose Public API for tool registry bridge
 */

export type {
  OpenClawTool,
  OpenClawToolRegistration,
  ToolRegistryEntry,
  ToolAction,
} from "./ToolRegistry.js";

export {
  openClawToolToEntry,
  entryToBrainTool,
  convertToolRegistrations,
} from "./ToolRegistry.js";

// Filesystem-based skill discovery (A.3.3)
export {
  discoverSkills,
  buildRichDescription,
} from "./SkillToToolConverter.js";

// Embedding cache (A.3.4)
export { ToolEmbeddingCache } from "./ToolEmbeddingCache.js";

// Registry manager (A.3.5)
export { ToolRegistryManager } from "./ToolRegistryManager.js";
export type { ToolRegistryManagerConfig } from "./ToolRegistryManager.js";
