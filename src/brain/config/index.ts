/**
 * Config Module — Stratus configuration types, validation, and migration
 *
 * @purpose Public API for Stratus configuration system
 */

export {
  resolveStratusConfig,
  DEFAULT_STRATUS_CONFIG,
  DEFAULT_TREE_SEARCH,
  DEFAULT_SIDECAR,
  DEFAULT_RECOVERY,
  DEFAULT_OBSERVABILITY,
} from "./StratusConfig.js";
export type {
  StratusAgentConfig,
  TreeSearchConfig,
  SidecarConfig,
  RecoveryConfig,
  ObservabilityConfig,
} from "./StratusConfig.js";

export { ConfigValidator } from "./ConfigValidator.js";
export type { ValidationResult, ValidationError, ValidationWarning } from "./ConfigValidator.js";

export { ConfigMigrator } from "./ConfigMigrator.js";
export type { OpenClawAgentConfig, MigrationResult } from "./ConfigMigrator.js";
