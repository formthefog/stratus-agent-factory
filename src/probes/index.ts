/**
 * Probes Module barrel
 *
 * @purpose Re-export probe training pipeline components (TS wrappers over Python backend)
 */

// E.1 Training Data Pipeline
export { TraceCollector } from "./TraceCollector.js";
export type {
  TraceCollectorConfig,
  PrivacyConfig,
  TraceStep,
  TraceRecord,
  CollectorStats,
} from "./TraceCollector.js";

export { SyntheticTrajectoryGenerator } from "./SyntheticTrajectoryGenerator.js";
export type {
  GeneratorConfig,
  GenerateInput,
  GenerateResult,
} from "./SyntheticTrajectoryGenerator.js";

export { TrainingDataValidator } from "./TrainingDataValidator.js";
export type {
  ValidationConfig as DataValidationConfig,
  ValidationResult as DataValidationResult,
  ValidationCheck,
} from "./TrainingDataValidator.js";

// E.2 Probe Training
export { ProbeTrainer } from "./ProbeTrainer.js";
export type {
  ProbeTrainerConfig,
  TrainProbeInput as ProbeTrainInput,
  ProbeHyperparams,
  TrainResult as ProbeTrainResult,
  TrainMetrics,
} from "./ProbeTrainer.js";

export { ProbeEvaluator } from "./ProbeEvaluator.js";
export type {
  ProbeEvaluatorConfig,
  EvaluateInput,
  EvaluationResult,
  BaselineComparison,
} from "./ProbeEvaluator.js";

export { ProbeRegistryBridge } from "./ProbeRegistryBridge.js";
export type {
  RegistryBridgeConfig,
  RegisteredProbe,
  ABTestConfig,
  ABTestResult,
} from "./ProbeRegistryBridge.js";

// E.3 Continuous Improvement
export { ProbePerformanceTracker } from "./ProbePerformanceTracker.js";
export type {
  PerformanceTrackerConfig,
  ProbeObservation,
  PerformanceSnapshot,
  DegradationReport,
} from "./ProbePerformanceTracker.js";

export { RetrainScheduler } from "./RetrainScheduler.js";
export type {
  RetrainSchedulerConfig,
  RetrainResult,
  CustomerPhase,
  SchedulerStatus,
} from "./RetrainScheduler.js";
