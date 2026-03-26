/**
 * Lifecycle Module barrel
 *
 * @purpose Re-export agent lifecycle management components
 */

// Version Manager (D.3.1)
export { VersionManager } from "./VersionManager.js";
export type {
  AgentVersion,
  VersionHistory,
  BlueGreenState,
  RollbackResult,
} from "./VersionManager.js";

// Health Monitor (D.3.2)
export { HealthMonitor } from "./HealthMonitor.js";
export type {
  HealthMonitorConfig,
  AlertThresholds,
  MetricSnapshot,
  HealthAlert,
  AlertType,
} from "./HealthMonitor.js";

// Auto-Updater (D.3.3)
export { AutoUpdater } from "./AutoUpdater.js";
export type {
  AutoUpdaterConfig,
  UpdateStep,
  UpdatePhase,
  UpdateResult,
  ModelVersionInfo,
} from "./AutoUpdater.js";
