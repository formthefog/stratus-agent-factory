/**
 * Agent Loader — Loads a packaged agent into the runtime environment
 *
 * Takes a validated agent package directory, loads all components
 * (config, tools, skills, probe, embeddings), and returns a runtime-ready
 * agent context. Validates compatibility with the current Stratus model version.
 *
 * @purpose Load agent packages into runtime, validating model compatibility
 * @spec AGENT_FACTORY_SPEC.md#d13-build-agent-loader
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type {
  PackageManifest,
  PackageValidationResult,
  PackageValidationError,
  PackageValidationWarning,
} from "./AgentPackage.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoaderOptions {
  /** Current Stratus model version for compatibility check */
  currentModelVersion: string;
  /** Whether to enforce strict model version match */
  strictVersionCheck?: boolean;
  /** Base directory for skill resolution */
  skillsBaseDir?: string;
}

/** Everything needed to run an agent */
export interface LoadedAgent {
  /** Agent identifier */
  agentId: string;
  /** Agent display name */
  agentName: string;
  /** Domain */
  domain: string;
  /** Parsed openclaw.json config */
  config: Record<string, unknown>;
  /** Agent instructions (AGENTS.md content) */
  instructions: string;
  /** Agent persona (SOUL.md content) */
  persona: string;
  /** Tool registry (raw YAML — parsed by ToolRegistryConverter at runtime) */
  toolRegistryYaml: string;
  /** Probe configuration */
  probe: LoadedProbe;
  /** Cached tool embeddings (Float32Array, shape: [numTools, 768]) */
  toolEmbeddings: Float32Array | null;
  /** Test scenarios (raw YAML) */
  testScenariosYaml: string | null;
  /** Resolved skill directories */
  skillDirs: string[];
  /** Package manifest */
  manifest: PackageManifest;
  /** Root directory of the loaded package */
  rootDir: string;
}

export interface LoadedProbe {
  /** Primary probe identifier */
  primaryProbeId: string;
  /** Fallback probe identifier */
  fallbackProbeId?: string;
  /** Custom probe weights (raw bytes) */
  customWeights: Buffer | null;
  /** Full probe config YAML */
  configYaml: string | null;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export class AgentLoader {
  private options: LoaderOptions;

  constructor(options: LoaderOptions) {
    this.options = options;
  }

  /**
   * Load an agent package from a directory.
   *
   * Reads the manifest, validates compatibility, and loads all components
   * into a runtime-ready LoadedAgent.
   */
  load(agentDir: string): LoadedAgent {
    // Load and validate manifest
    const manifest = this.loadManifest(agentDir);
    this.checkCompatibility(manifest);

    // Load required files
    const config = JSON.parse(
      readFileSync(join(agentDir, "openclaw.json"), "utf-8"),
    );
    const instructions = readFileSync(join(agentDir, "AGENTS.md"), "utf-8");
    const persona = readFileSync(join(agentDir, "SOUL.md"), "utf-8");
    const toolRegistryYaml = readFileSync(
      join(agentDir, "agent.tools.yaml"),
      "utf-8",
    );

    // Load optional files
    const probe = this.loadProbe(agentDir, manifest);
    const toolEmbeddings = this.loadEmbeddings(agentDir);
    const testScenariosYaml = this.loadOptionalFile(
      agentDir,
      "tests/scenarios.yaml",
    );
    const skillDirs = this.resolveSkills(agentDir);

    return {
      agentId: manifest.agentId,
      agentName: manifest.agentName,
      domain: manifest.domain,
      config,
      instructions,
      persona,
      toolRegistryYaml,
      probe,
      toolEmbeddings,
      testScenariosYaml,
      skillDirs,
      manifest,
      rootDir: agentDir,
    };
  }

  /**
   * Quick-load just the manifest and basic info without loading all files.
   * Useful for listing installed agents.
   */
  loadInfo(agentDir: string): {
    agentId: string;
    agentName: string;
    domain: string;
    toolCount: number;
    hasCustomProbe: boolean;
    compatible: boolean;
  } {
    const manifest = this.loadManifest(agentDir);
    const compatible = this.isCompatible(manifest);

    return {
      agentId: manifest.agentId,
      agentName: manifest.agentName,
      domain: manifest.domain,
      toolCount: manifest.tools.count,
      hasCustomProbe: manifest.probe.hasCustomWeights,
      compatible,
    };
  }

  /**
   * Validate that a package can be loaded without actually loading it.
   */
  validateForLoading(agentDir: string): PackageValidationResult {
    const errors: PackageValidationError[] = [];
    const warnings: PackageValidationWarning[] = [];

    // Check manifest exists
    const manifestPath = join(agentDir, ".stratus", "manifest.json");
    if (!existsSync(manifestPath)) {
      errors.push({
        code: "INVALID_MANIFEST",
        message: "No .stratus/manifest.json — run AgentPackager first",
      });
      return { valid: false, errors, warnings };
    }

    // Load manifest and check version
    try {
      const manifest = this.loadManifest(agentDir);

      if (!this.isCompatible(manifest)) {
        if (this.options.strictVersionCheck) {
          errors.push({
            code: "MODEL_VERSION_MISMATCH",
            message: `Package built for Stratus ${manifest.stratusModelVersion}, current is ${this.options.currentModelVersion}`,
          });
        } else {
          warnings.push({
            code: "STALE_EMBEDDINGS",
            message: `Package built for Stratus ${manifest.stratusModelVersion} — tool embeddings may need regeneration`,
          });
        }
      }

      // Verify required files still exist
      for (const entry of manifest.files) {
        if (entry.required && !existsSync(join(agentDir, entry.path))) {
          errors.push({
            code: "MISSING_REQUIRED_FILE",
            message: `Required file missing: ${entry.path}`,
            file: entry.path,
          });
        }
      }

      // Verify checksums for required files
      for (const entry of manifest.files) {
        if (!entry.required) continue;
        const filePath = join(agentDir, entry.path);
        if (!existsSync(filePath)) continue;

        const { createHash } = require("node:crypto");
        const content = readFileSync(filePath);
        const actual = createHash("sha256").update(content).digest("hex");

        if (actual !== entry.checksum) {
          warnings.push({
            code: "STALE_EMBEDDINGS",
            message: `File modified since packaging: ${entry.path}`,
            file: entry.path,
          });
        }
      }
    } catch (err) {
      errors.push({
        code: "INVALID_MANIFEST",
        message: `Failed to read manifest: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  // -----------------------------------------------------------------------
  // Manifest
  // -----------------------------------------------------------------------

  private loadManifest(agentDir: string): PackageManifest {
    const manifestPath = join(agentDir, ".stratus", "manifest.json");

    if (!existsSync(manifestPath)) {
      throw new Error(
        `No manifest at ${manifestPath} — run AgentPackager.package() first`,
      );
    }

    const raw = readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(raw) as PackageManifest;

    if (manifest.formatVersion !== 1) {
      throw new Error(
        `Unsupported package format version: ${manifest.formatVersion}`,
      );
    }

    return manifest;
  }

  // -----------------------------------------------------------------------
  // Compatibility
  // -----------------------------------------------------------------------

  private checkCompatibility(manifest: PackageManifest): void {
    if (this.options.strictVersionCheck && !this.isCompatible(manifest)) {
      throw new Error(
        `Model version mismatch: package requires ${manifest.stratusModelVersion}, ` +
        `current is ${this.options.currentModelVersion}. ` +
        `Repackage with current model or disable strict version check.`,
      );
    }
  }

  private isCompatible(manifest: PackageManifest): boolean {
    // Major version must match (e.g., "v6.1" and "v6.2" are compatible)
    const packageMajor = this.majorVersion(manifest.stratusModelVersion);
    const currentMajor = this.majorVersion(this.options.currentModelVersion);
    return packageMajor === currentMajor;
  }

  private majorVersion(version: string): string {
    // "v6.1.0" → "v6", "v6" → "v6"
    const match = version.match(/^(v?\d+)/);
    return match?.[1] ?? version;
  }

  // -----------------------------------------------------------------------
  // Component loaders
  // -----------------------------------------------------------------------

  private loadProbe(agentDir: string, manifest: PackageManifest): LoadedProbe {
    const configPath = join(agentDir, "probe", "probe_config.yaml");
    const weightsPath = join(agentDir, "probe", "weights.pt");

    return {
      primaryProbeId: manifest.probe.primaryProbeId,
      fallbackProbeId: manifest.probe.fallbackProbeId,
      customWeights: existsSync(weightsPath) ? readFileSync(weightsPath) : null,
      configYaml: existsSync(configPath) ? readFileSync(configPath, "utf-8") : null,
    };
  }

  private loadEmbeddings(agentDir: string): Float32Array | null {
    const embPath = join(agentDir, ".stratus", "tool_embeddings.bin");
    if (!existsSync(embPath)) return null;

    const buffer = readFileSync(embPath);
    return new Float32Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength / 4,
    );
  }

  private loadOptionalFile(agentDir: string, relPath: string): string | null {
    const fullPath = join(agentDir, relPath);
    if (!existsSync(fullPath)) return null;
    return readFileSync(fullPath, "utf-8");
  }

  private resolveSkills(agentDir: string): string[] {
    const skillsDir = join(agentDir, "skills");
    if (!existsSync(skillsDir)) return [];

    const dirs: string[] = [];
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        dirs.push(join(skillsDir, entry.name));
      }
    }
    return dirs;
  }
}
