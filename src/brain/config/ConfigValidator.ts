/**
 * Config Validator — Validates Stratus configuration on startup
 *
 * Checks that the Stratus agent config is internally consistent and that
 * referenced resources (model files, probes) are reachable. Returns
 * structured validation results with clear error messages.
 *
 * @purpose Validate Stratus config on startup with actionable error messages
 * @spec AGENT_FACTORY_SPEC.md#a52-build-config-validator
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { StratusAgentConfig } from "./StratusConfig.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  field: string;
  message: string;
  value?: unknown;
}

export interface ValidationWarning {
  field: string;
  message: string;
  suggestion?: string;
}

// ---------------------------------------------------------------------------
// Known Values
// ---------------------------------------------------------------------------

const KNOWN_PROBES = [
  "planning-v1",
  "planning-v2",
  "tool-use-v1",
  "error-recovery-v1",
  "goal-decomposition-v1",
];

const KNOWN_LLM_PROVIDERS = ["anthropic", "openai", "local"];

const KNOWN_OBSERVATION_ENCODERS: Array<"adapter" | "llm_bridge" | "direct"> = [
  "adapter",
  "llm_bridge",
  "direct",
];

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export class ConfigValidator {
  /**
   * Validate a resolved Stratus config.
   *
   * Checks:
   * - Model file exists (expands ~)
   * - Probe ID is known or custom probe path exists
   * - LLM provider is recognized
   * - Numeric ranges are sane
   * - Sidecar port is valid
   * - Observation encoder is a known mode
   */
  validate(config: StratusAgentConfig): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // -- Model path --
    this.validateModelPath(config.modelPath, errors, warnings);

    // -- Probe --
    this.validateProbe(config.probe, config.customProbePath, errors, warnings);

    // -- LLM provider --
    this.validateLlmProvider(config.llmProvider, config.llmModel, errors, warnings);

    // -- Observation encoder --
    if (!KNOWN_OBSERVATION_ENCODERS.includes(config.observationEncoder)) {
      errors.push({
        field: "observationEncoder",
        message: `Unknown observation encoder "${config.observationEncoder}". Expected one of: ${KNOWN_OBSERVATION_ENCODERS.join(", ")}`,
        value: config.observationEncoder,
      });
    }

    // -- Numeric ranges --
    this.validateNumericRanges(config, errors);

    // -- Tree search --
    this.validateTreeSearch(config.treeSearch, errors);

    // -- Sidecar --
    this.validateSidecar(config.sidecar, errors);

    // -- Recovery --
    this.validateRecovery(config.recovery, errors);

    // -- Observability --
    this.validateObservability(config.observability, warnings);

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate and throw if invalid. Convenience for startup.
   */
  validateOrThrow(config: StratusAgentConfig): void {
    const result = this.validate(config);
    if (!result.valid) {
      const msg = result.errors
        .map((e) => `  [${e.field}] ${e.message}`)
        .join("\n");
      throw new Error(`Stratus config validation failed:\n${msg}`);
    }
  }

  // -----------------------------------------------------------------------
  // Field Validators
  // -----------------------------------------------------------------------

  private validateModelPath(
    modelPath: string,
    errors: ValidationError[],
    warnings: ValidationWarning[],
  ): void {
    if (!modelPath) {
      errors.push({
        field: "modelPath",
        message: "Model path is required",
      });
      return;
    }

    const expanded = modelPath.startsWith("~")
      ? resolve(homedir(), modelPath.slice(2))
      : resolve(modelPath);

    if (!existsSync(expanded)) {
      warnings.push({
        field: "modelPath",
        message: `Model file not found at "${expanded}". Sidecar will fail to load.`,
        suggestion: "Download the model or update modelPath in your config.",
      });
    }
  }

  private validateProbe(
    probe: string,
    customProbePath: string | undefined,
    errors: ValidationError[],
    warnings: ValidationWarning[],
  ): void {
    if (!probe) {
      errors.push({
        field: "probe",
        message: "Probe ID is required",
      });
      return;
    }

    const isKnown = KNOWN_PROBES.includes(probe);

    if (!isKnown && !customProbePath) {
      warnings.push({
        field: "probe",
        message: `Probe "${probe}" is not a built-in probe and no customProbePath is set.`,
        suggestion: `Use one of: ${KNOWN_PROBES.join(", ")} — or set customProbePath for a custom probe.`,
      });
    }

    if (customProbePath) {
      const expanded = customProbePath.startsWith("~")
        ? resolve(homedir(), customProbePath.slice(2))
        : resolve(customProbePath);

      if (!existsSync(expanded)) {
        errors.push({
          field: "customProbePath",
          message: `Custom probe file not found at "${expanded}"`,
          value: customProbePath,
        });
      }
    }
  }

  private validateLlmProvider(
    provider: string,
    model: string,
    errors: ValidationError[],
    warnings: ValidationWarning[],
  ): void {
    if (!provider) {
      errors.push({
        field: "llmProvider",
        message: "LLM provider is required",
      });
      return;
    }

    if (!KNOWN_LLM_PROVIDERS.includes(provider)) {
      warnings.push({
        field: "llmProvider",
        message: `Unknown LLM provider "${provider}". Known providers: ${KNOWN_LLM_PROVIDERS.join(", ")}`,
        suggestion: "This may work if you have a custom provider adapter configured.",
      });
    }

    if (!model) {
      errors.push({
        field: "llmModel",
        message: "LLM model is required",
      });
    }
  }

  private validateNumericRanges(
    config: StratusAgentConfig,
    errors: ValidationError[],
  ): void {
    if (config.goalProximityThreshold <= 0 || config.goalProximityThreshold > 1) {
      errors.push({
        field: "goalProximityThreshold",
        message: `Must be in (0, 1], got ${config.goalProximityThreshold}`,
        value: config.goalProximityThreshold,
      });
    }

    if (config.maxSteps < 1 || config.maxSteps > 100) {
      errors.push({
        field: "maxSteps",
        message: `Must be in [1, 100], got ${config.maxSteps}`,
        value: config.maxSteps,
      });
    }
  }

  private validateTreeSearch(
    ts: StratusAgentConfig["treeSearch"],
    errors: ValidationError[],
  ): void {
    if (ts.maxDepth < 1 || ts.maxDepth > 10) {
      errors.push({
        field: "treeSearch.maxDepth",
        message: `Must be in [1, 10], got ${ts.maxDepth}`,
        value: ts.maxDepth,
      });
    }

    if (ts.beamWidth < 1 || ts.beamWidth > 20) {
      errors.push({
        field: "treeSearch.beamWidth",
        message: `Must be in [1, 20], got ${ts.beamWidth}`,
        value: ts.beamWidth,
      });
    }

    if (ts.ambiguityThreshold <= 0 || ts.ambiguityThreshold > 1) {
      errors.push({
        field: "treeSearch.ambiguityThreshold",
        message: `Must be in (0, 1], got ${ts.ambiguityThreshold}`,
        value: ts.ambiguityThreshold,
      });
    }

    if (ts.timeBudgetMs < 50 || ts.timeBudgetMs > 10_000) {
      errors.push({
        field: "treeSearch.timeBudgetMs",
        message: `Must be in [50, 10000], got ${ts.timeBudgetMs}`,
        value: ts.timeBudgetMs,
      });
    }
  }

  private validateSidecar(
    sc: StratusAgentConfig["sidecar"],
    errors: ValidationError[],
  ): void {
    if (sc.port < 1 || sc.port > 65535) {
      errors.push({
        field: "sidecar.port",
        message: `Must be in [1, 65535], got ${sc.port}`,
        value: sc.port,
      });
    }

    if (sc.timeoutMs < 1000) {
      errors.push({
        field: "sidecar.timeoutMs",
        message: `Must be >= 1000ms, got ${sc.timeoutMs}`,
        value: sc.timeoutMs,
      });
    }
  }

  private validateRecovery(
    rc: StratusAgentConfig["recovery"],
    errors: ValidationError[],
  ): void {
    if (rc.maxRollbackDepth < 0 || rc.maxRollbackDepth > 10) {
      errors.push({
        field: "recovery.maxRollbackDepth",
        message: `Must be in [0, 10], got ${rc.maxRollbackDepth}`,
        value: rc.maxRollbackDepth,
      });
    }

    if (rc.maxRecoveryAttempts < 1 || rc.maxRecoveryAttempts > 20) {
      errors.push({
        field: "recovery.maxRecoveryAttempts",
        message: `Must be in [1, 20], got ${rc.maxRecoveryAttempts}`,
        value: rc.maxRecoveryAttempts,
      });
    }
  }

  private validateObservability(
    obs: StratusAgentConfig["observability"],
    warnings: ValidationWarning[],
  ): void {
    if (!obs.traceEnabled && !obs.profileEnabled && !obs.trajectoryEnabled) {
      warnings.push({
        field: "observability",
        message: "All observability features are disabled. Debugging will be difficult.",
        suggestion: "Enable at least traceEnabled for production use.",
      });
    }
  }
}
