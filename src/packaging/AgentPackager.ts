/**
 * Agent Packager — Validates and packages agent directories
 *
 * Takes a raw agent config directory (output of ConfigureAgentTool or
 * a template), validates completeness, computes checksums, and writes
 * the .stratus/manifest.json that makes it a proper package.
 *
 * @purpose Validate agent directories and produce deployable packages
 * @spec AGENT_FACTORY_SPEC.md#d12-build-agent-packager
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";

import type {
  AgentPackage,
  PackageManifest,
  PackageFileEntry,
  PackageValidationResult,
  PackageValidationError,
  PackageValidationWarning,
  PackageErrorCode,
  PackageWarningCode,
  ProbeManifestEntry,
  ToolManifestEntry,
} from "./AgentPackage.js";

import { REQUIRED_FILES } from "./AgentPackage.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PackagerOptions {
  /** Stratus model version to stamp on the manifest */
  stratusModelVersion: string;
  /** Whether to regenerate tool embeddings cache (requires sidecar) */
  cacheEmbeddings?: boolean;
  /** Sidecar URL for embedding generation */
  sidecarUrl?: string;
}

// ---------------------------------------------------------------------------
// Packager
// ---------------------------------------------------------------------------

export class AgentPackager {
  private options: PackagerOptions;

  constructor(options: PackagerOptions) {
    this.options = options;
  }

  /**
   * Validate an agent directory without creating a package.
   */
  validate(agentDir: string): PackageValidationResult {
    const errors: PackageValidationError[] = [];
    const warnings: PackageValidationWarning[] = [];

    // Check required files
    for (const file of REQUIRED_FILES) {
      if (!existsSync(join(agentDir, file))) {
        errors.push({
          code: "MISSING_REQUIRED_FILE",
          message: `Required file missing: ${file}`,
          file,
        });
      }
    }

    // Validate openclaw.json
    const configPath = join(agentDir, "openclaw.json");
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, "utf-8"));
        if (!config.name) {
          errors.push({
            code: "INVALID_CONFIG",
            message: "openclaw.json missing 'name' field",
            file: "openclaw.json",
          });
        }
      } catch {
        errors.push({
          code: "INVALID_CONFIG",
          message: "openclaw.json is not valid JSON",
          file: "openclaw.json",
        });
      }
    }

    // Validate agent.tools.yaml
    const toolsPath = join(agentDir, "agent.tools.yaml");
    if (existsSync(toolsPath)) {
      const content = readFileSync(toolsPath, "utf-8");
      const toolIds = this.extractToolIds(content);
      if (toolIds.length === 0) {
        errors.push({
          code: "INVALID_TOOL_REGISTRY",
          message: "agent.tools.yaml contains no tool definitions",
          file: "agent.tools.yaml",
        });
      }
    }

    // Validate probe consistency
    const probeConfigPath = join(agentDir, "probe", "probe_config.yaml");
    const probeWeightsPath = join(agentDir, "probe", "weights.pt");
    if (existsSync(probeConfigPath)) {
      const probeConfig = readFileSync(probeConfigPath, "utf-8");
      const hasCustomRef = probeConfig.includes("custom_weights") ||
        probeConfig.includes("weights_path");
      if (hasCustomRef && !existsSync(probeWeightsPath)) {
        errors.push({
          code: "PROBE_WEIGHTS_MISSING",
          message: "probe_config.yaml references custom weights but weights.pt is missing",
          file: "probe/weights.pt",
        });
      }
    }

    // Warnings for optional but recommended files
    if (!existsSync(join(agentDir, "tests", "scenarios.yaml"))) {
      warnings.push({
        code: "NO_TEST_SCENARIOS",
        message: "No test scenarios — package cannot be verified before deployment",
        file: "tests/scenarios.yaml",
      });
    }

    if (!existsSync(join(agentDir, ".stratus", "tool_embeddings.bin"))) {
      warnings.push({
        code: "NO_EMBEDDINGS_CACHE",
        message: "No cached tool embeddings — first inference will be slower",
        file: ".stratus/tool_embeddings.bin",
      });
    }

    if (!existsSync(probeWeightsPath)) {
      warnings.push({
        code: "NO_PROBE_WEIGHTS",
        message: "No custom probe weights — agent will use general probe",
        file: "probe/weights.pt",
      });
    }

    if (!existsSync(join(agentDir, "skills"))) {
      warnings.push({
        code: "NO_SKILLS",
        message: "No skills directory — agent has no OpenClaw skills",
        file: "skills/",
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Package an agent directory. Validates, computes checksums, writes manifest.
   *
   * Returns the AgentPackage if successful, throws if validation fails.
   */
  async package(agentDir: string): Promise<AgentPackage> {
    // Validate first
    const validation = this.validate(agentDir);
    if (!validation.valid) {
      const errorMessages = validation.errors.map((e) => e.message).join("; ");
      throw new Error(`Package validation failed: ${errorMessages}`);
    }

    // Read config for agent metadata
    const config = JSON.parse(
      readFileSync(join(agentDir, "openclaw.json"), "utf-8"),
    );

    // Collect all files with checksums
    const files = this.collectFiles(agentDir);

    // Build probe manifest entry
    const probe = this.buildProbeManifest(agentDir);

    // Build tools manifest entry
    const tools = this.buildToolsManifest(agentDir);

    // Optionally cache embeddings
    if (this.options.cacheEmbeddings && this.options.sidecarUrl) {
      await this.cacheToolEmbeddings(agentDir, tools.ids);
    }

    // Build manifest
    const manifest: PackageManifest = {
      formatVersion: 1,
      agentId: this.toKebabCase(config.name),
      agentName: config.name,
      domain: config.stratus?.domain ?? config.domain ?? "general",
      stratusModelVersion: this.options.stratusModelVersion,
      createdAt: new Date().toISOString(),
      files,
      probe,
      tools,
    };

    // Write manifest
    const stratusDir = join(agentDir, ".stratus");
    mkdirSync(stratusDir, { recursive: true });
    writeFileSync(
      join(stratusDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );

    return { manifest, rootDir: agentDir };
  }

  // -----------------------------------------------------------------------
  // File collection
  // -----------------------------------------------------------------------

  private collectFiles(dir: string, base?: string): PackageFileEntry[] {
    const root = base ?? dir;
    const entries: PackageFileEntry[] = [];

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(root, fullPath);

      if (entry.isDirectory()) {
        // Skip .stratus during collection (we'll add manifest after)
        if (entry.name === ".stratus") continue;
        entries.push(...this.collectFiles(fullPath, root));
      } else {
        const content = readFileSync(fullPath);
        const checksum = createHash("sha256").update(content).digest("hex");
        const stat = statSync(fullPath);
        const required = (REQUIRED_FILES as readonly string[]).includes(relPath);

        entries.push({
          path: relPath,
          checksum,
          size: stat.size,
          required,
        });
      }
    }

    return entries;
  }

  // -----------------------------------------------------------------------
  // Manifest builders
  // -----------------------------------------------------------------------

  private buildProbeManifest(agentDir: string): ProbeManifestEntry {
    const configPath = join(agentDir, "probe", "probe_config.yaml");
    const weightsPath = join(agentDir, "probe", "weights.pt");

    if (!existsSync(configPath)) {
      return {
        primaryProbeId: "planning-v2",
        hasCustomWeights: false,
        fallbackProbeId: "planning-v1",
      };
    }

    const content = readFileSync(configPath, "utf-8");

    // Simple YAML extraction for probe IDs
    const primaryMatch = content.match(/primary[_\s]*(?:probe)?[:\s]+["']?(\S+?)["']?\s*$/m);
    const fallbackMatch = content.match(/fallback[_\s]*(?:probe)?[:\s]+["']?(\S+?)["']?\s*$/m);

    return {
      primaryProbeId: primaryMatch?.[1] ?? "planning-v2",
      hasCustomWeights: existsSync(weightsPath),
      fallbackProbeId: fallbackMatch?.[1],
    };
  }

  private buildToolsManifest(agentDir: string): ToolManifestEntry {
    const toolsPath = join(agentDir, "agent.tools.yaml");

    if (!existsSync(toolsPath)) {
      return { count: 0, ids: [], hasEmbeddingsCache: false };
    }

    const content = readFileSync(toolsPath, "utf-8");
    const ids = this.extractToolIds(content);

    return {
      count: ids.length,
      ids,
      hasEmbeddingsCache: existsSync(join(agentDir, ".stratus", "tool_embeddings.bin")),
    };
  }

  // -----------------------------------------------------------------------
  // Embeddings cache
  // -----------------------------------------------------------------------

  private async cacheToolEmbeddings(agentDir: string, toolIds: string[]): Promise<void> {
    if (!this.options.sidecarUrl || toolIds.length === 0) return;

    const toolsContent = readFileSync(join(agentDir, "agent.tools.yaml"), "utf-8");

    // Extract rich descriptions for encoding
    const descriptions: string[] = [];
    const lines = toolsContent.split("\n");
    for (const line of lines) {
      const match = line.match(/rich_description:\s*"(.+)"/);
      if (match) descriptions.push(match[1]);
    }

    if (descriptions.length === 0) return;

    try {
      const response = await fetch(`${this.options.sidecarUrl}/encode_actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action_texts: descriptions }),
      });

      if (!response.ok) return; // Non-fatal — embeddings can be computed at runtime

      const result = await response.json();
      if (result.embeddings) {
        const stratusDir = join(agentDir, ".stratus");
        mkdirSync(stratusDir, { recursive: true });

        // Write embeddings as binary float32 array
        const flat = (result.embeddings as number[][]).flat();
        const buffer = Buffer.from(new Float32Array(flat).buffer);
        writeFileSync(join(stratusDir, "tool_embeddings.bin"), buffer);
      }
    } catch {
      // Sidecar unavailable — skip cache, not fatal
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private extractToolIds(yamlContent: string): string[] {
    const ids: string[] = [];
    for (const line of yamlContent.split("\n")) {
      const match = line.match(/^\s+-\s+id:\s+(\S+)/);
      if (match) ids.push(match[1]);
    }
    return ids;
  }

  private toKebabCase(name: string): string {
    return name
      .replace(/([a-z])([A-Z])/g, "$1-$2")
      .replace(/[\s_]+/g, "-")
      .toLowerCase();
  }
}
