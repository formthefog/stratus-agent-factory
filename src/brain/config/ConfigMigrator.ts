/**
 * Config Migrator — Converts vanilla OpenClaw config to Stratus-enhanced config
 *
 * When an OpenClaw agent selects brain: "stratus", the harness passes the
 * agent's openclaw.json config. This migrator extracts any existing Stratus
 * settings, merges with defaults, and produces a fully resolved StratusAgentConfig.
 *
 * @purpose Convert OpenClaw agent config to Stratus-enhanced config
 * @spec AGENT_FACTORY_SPEC.md#a53-build-config-migration-tool
 */

import {
  resolveStratusConfig,
  type StratusAgentConfig,
} from "./StratusConfig.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Shape of an OpenClaw agent config (openclaw.json).
 * Structural typing — we don't import from OpenClaw core.
 */
export interface OpenClawAgentConfig {
  /** Agent identifier */
  id?: string;
  /** Brain type (e.g. "react", "stratus") */
  brain?: string;
  /** LLM provider */
  provider?: string;
  /** LLM model */
  model?: string;
  /** Stratus-specific config block (if already present) */
  stratus?: Partial<StratusAgentConfig>;
  /** Any other fields — preserved but not consumed */
  [key: string]: unknown;
}

export interface MigrationResult {
  /** The resolved Stratus config */
  config: StratusAgentConfig;
  /** Fields that were migrated from top-level OpenClaw config */
  migratedFields: string[];
  /** Whether the original config already had a stratus block */
  hadStratusBlock: boolean;
}

// ---------------------------------------------------------------------------
// Migrator
// ---------------------------------------------------------------------------

export class ConfigMigrator {
  /**
   * Migrate an OpenClaw agent config to a resolved Stratus config.
   *
   * Migration rules:
   * 1. If `stratus` block exists, use it as the base
   * 2. Pull `provider` → `llmProvider` if not set in stratus block
   * 3. Pull `model` → `llmModel` if not set in stratus block
   * 4. Merge with defaults for any missing fields
   */
  migrate(agentConfig: OpenClawAgentConfig): MigrationResult {
    const migratedFields: string[] = [];
    const hadStratusBlock = agentConfig.stratus != null;

    // Start with existing stratus block or empty
    const partial: Partial<StratusAgentConfig> = {
      ...(agentConfig.stratus ?? {}),
    };

    // Migrate top-level provider → llmProvider
    if (!partial.llmProvider && agentConfig.provider) {
      partial.llmProvider = agentConfig.provider;
      migratedFields.push("provider → llmProvider");
    }

    // Migrate top-level model → llmModel
    if (!partial.llmModel && agentConfig.model) {
      partial.llmModel = agentConfig.model;
      migratedFields.push("model → llmModel");
    }

    // Resolve with defaults
    const config = resolveStratusConfig(partial);

    return {
      config,
      migratedFields,
      hadStratusBlock,
    };
  }

  /**
   * Check if an OpenClaw config needs migration.
   *
   * Returns true if:
   * - No stratus block exists (needs full defaults)
   * - Top-level provider/model could be pulled in
   */
  needsMigration(agentConfig: OpenClawAgentConfig): boolean {
    if (!agentConfig.stratus) return true;

    // Has stratus block but top-level fields could supplement
    if (!agentConfig.stratus.llmProvider && agentConfig.provider) return true;
    if (!agentConfig.stratus.llmModel && agentConfig.model) return true;

    return false;
  }

  /**
   * Generate a stratus config block that can be written back to openclaw.json.
   * Only includes non-default values.
   */
  generateConfigBlock(config: StratusAgentConfig): Partial<StratusAgentConfig> {
    const resolved = resolveStratusConfig();
    const block: Record<string, unknown> = {};

    // Only include fields that differ from defaults
    for (const key of Object.keys(config) as Array<keyof StratusAgentConfig>) {
      const value = config[key];
      const defaultValue = resolved[key];

      if (typeof value === "object" && value !== null) {
        // For nested objects, compare stringified
        if (JSON.stringify(value) !== JSON.stringify(defaultValue)) {
          block[key] = value;
        }
      } else if (value !== defaultValue) {
        block[key] = value;
      }
    }

    return block as Partial<StratusAgentConfig>;
  }
}
