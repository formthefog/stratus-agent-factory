/**
 * Packaging Module barrel
 *
 * @purpose Re-export agent packaging, loading, and format types
 */

// Package format (D.1.1)
export {
  REQUIRED_FILES,
  OPTIONAL_FILES,
  OPTIONAL_DIRS,
} from "./AgentPackage.js";
export type {
  AgentPackage,
  PackageManifest,
  PackageFileEntry,
  ProbeManifestEntry,
  ToolManifestEntry,
  PackageValidationResult,
  PackageValidationError,
  PackageValidationWarning,
  PackageErrorCode,
  PackageWarningCode,
  AgentPackageInfo,
} from "./AgentPackage.js";

// Packager (D.1.2)
export { AgentPackager } from "./AgentPackager.js";
export type { PackagerOptions } from "./AgentPackager.js";

// Loader (D.1.3)
export { AgentLoader } from "./AgentLoader.js";
export type {
  LoaderOptions,
  LoadedAgent,
  LoadedProbe,
} from "./AgentLoader.js";
