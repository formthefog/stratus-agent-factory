/**
 * Agent Package Format — Self-contained, language-agnostic agent definition
 *
 * An agent package is a directory containing YAML, JSON, Markdown, and binary
 * files — no code. This format is designed so that v2 (Python) loads the
 * exact same packages with zero conversion.
 *
 * @purpose Define the agent package format and validation types
 * @spec AGENT_FACTORY_SPEC.md#d11-define-agent-package-format
 */

// ---------------------------------------------------------------------------
// Package Structure
// ---------------------------------------------------------------------------

/**
 * The canonical agent package layout:
 *
 * my-agent/
 *   openclaw.json           # full config with Stratus settings
 *   AGENTS.md               # agent instructions
 *   SOUL.md                 # agent persona
 *   agent.tools.yaml        # tool registry
 *   skills/                 # OpenClaw skill directories
 *   probe/                  # probe weights (if custom)
 *     probe_config.yaml
 *     weights.pt
 *   tests/
 *     scenarios.yaml        # test scenarios
 *     results/              # last test run results
 *   .stratus/
 *     tool_embeddings.bin   # cached action embeddings
 *     manifest.json         # package manifest with checksums
 */

export interface AgentPackage {
  /** Package manifest */
  manifest: PackageManifest;
  /** Resolved root directory path */
  rootDir: string;
}

export interface PackageManifest {
  /** Schema version for forward compatibility */
  formatVersion: 1;
  /** Agent identifier (kebab-case) */
  agentId: string;
  /** Human-readable name */
  agentName: string;
  /** Domain this agent operates in */
  domain: string;
  /** Stratus model version this package was built against */
  stratusModelVersion: string;
  /** When this package was created */
  createdAt: string;
  /** Package contents with checksums */
  files: PackageFileEntry[];
  /** Probe configuration summary */
  probe: ProbeManifestEntry;
  /** Tool count and IDs for quick reference */
  tools: ToolManifestEntry;
}

export interface PackageFileEntry {
  /** Path relative to package root */
  path: string;
  /** SHA-256 hex digest */
  checksum: string;
  /** File size in bytes */
  size: number;
  /** Whether this file is required or optional */
  required: boolean;
}

export interface ProbeManifestEntry {
  /** Primary probe ID */
  primaryProbeId: string;
  /** Whether custom weights are included */
  hasCustomWeights: boolean;
  /** Fallback probe ID (if any) */
  fallbackProbeId?: string;
}

export interface ToolManifestEntry {
  /** Number of tools in registry */
  count: number;
  /** Tool IDs for quick reference */
  ids: string[];
  /** Whether cached embeddings are included */
  hasEmbeddingsCache: boolean;
}

// ---------------------------------------------------------------------------
// Required & Optional Files
// ---------------------------------------------------------------------------

/** Files that MUST exist in a valid package */
export const REQUIRED_FILES = [
  "openclaw.json",
  "AGENTS.md",
  "SOUL.md",
  "agent.tools.yaml",
] as const;

/** Files that MAY exist */
export const OPTIONAL_FILES = [
  "probe/probe_config.yaml",
  "probe/weights.pt",
  "tests/scenarios.yaml",
  ".stratus/tool_embeddings.bin",
  ".stratus/manifest.json",
] as const;

/** Directories that MAY exist */
export const OPTIONAL_DIRS = [
  "skills",
  "probe",
  "tests",
  "tests/results",
  ".stratus",
] as const;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface PackageValidationResult {
  valid: boolean;
  errors: PackageValidationError[];
  warnings: PackageValidationWarning[];
}

export interface PackageValidationError {
  code: PackageErrorCode;
  message: string;
  file?: string;
}

export interface PackageValidationWarning {
  code: PackageWarningCode;
  message: string;
  file?: string;
}

export type PackageErrorCode =
  | "MISSING_REQUIRED_FILE"
  | "INVALID_CONFIG"
  | "INVALID_TOOL_REGISTRY"
  | "PROBE_WEIGHTS_MISSING"
  | "PROBE_CONFIG_MISSING"
  | "CHECKSUM_MISMATCH"
  | "INVALID_MANIFEST"
  | "MODEL_VERSION_MISMATCH";

export type PackageWarningCode =
  | "NO_TEST_SCENARIOS"
  | "NO_EMBEDDINGS_CACHE"
  | "NO_PROBE_WEIGHTS"
  | "NO_SKILLS"
  | "STALE_EMBEDDINGS"
  | "NO_TEST_RESULTS";

// ---------------------------------------------------------------------------
// Package Info (lightweight, no file loading)
// ---------------------------------------------------------------------------

export interface AgentPackageInfo {
  agentId: string;
  agentName: string;
  domain: string;
  rootDir: string;
  toolCount: number;
  hasCustomProbe: boolean;
  hasTests: boolean;
  stratusModelVersion: string;
  createdAt: string;
}
