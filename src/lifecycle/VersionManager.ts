/**
 * Version Manager — Track agent versions and support rollback
 *
 * Every deployment creates a versioned snapshot. The version manager
 * tracks these snapshots, supports instant rollback, and enables
 * blue/green deployment for zero-downtime updates.
 *
 * @purpose Track agent versions, enable rollback and blue/green deployment
 * @spec AGENT_FACTORY_SPEC.md#d31-build-agent-version-manager
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentVersion {
  /** Semantic-ish version (auto-incremented) */
  version: string;
  /** When this version was created */
  createdAt: string;
  /** What changed in this version */
  changelog: string;
  /** Snapshot of the manifest at this version */
  manifest: {
    agentId: string;
    domain: string;
    stratusModelVersion: string;
    probeId: string;
    hasCustomWeights: boolean;
    toolCount: number;
    toolIds: string[];
  };
  /** SHA-256 of the config files for change detection */
  configHash: string;
  /** SHA-256 of probe weights (if any) */
  probeHash: string | null;
  /** Deployment status */
  status: "active" | "inactive" | "rolling-back";
}

export interface VersionHistory {
  agentId: string;
  currentVersion: string;
  versions: AgentVersion[];
}

export interface BlueGreenState {
  /** Currently serving traffic */
  activeSlot: "blue" | "green";
  /** Slot being prepared for cutover */
  stagingSlot: "blue" | "green";
  /** Blue slot version */
  blueVersion: string | null;
  /** Green slot version */
  greenVersion: string | null;
}

export interface RollbackResult {
  success: boolean;
  fromVersion: string;
  toVersion: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class VersionManager {
  private versionsDir: string;

  /**
   * @param baseDir — Root directory for version storage (e.g. ~/.openclaw/versions/)
   */
  constructor(baseDir: string) {
    this.versionsDir = baseDir;
    mkdirSync(this.versionsDir, { recursive: true });
  }

  /**
   * Create a new version snapshot from the current agent package.
   */
  createVersion(
    agentDir: string,
    changelog: string,
  ): AgentVersion {
    const manifestPath = join(agentDir, ".stratus", "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new Error("No manifest — package the agent first");
    }

    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const agentId = manifest.agentId;

    // Load or create history
    const history = this.getHistory(agentId);

    // Compute next version
    const nextVersion = this.nextVersion(history);

    // Hash config files for change detection
    const configHash = this.hashFiles(agentDir, [
      "openclaw.json",
      "agent.tools.yaml",
      "AGENTS.md",
      "SOUL.md",
    ]);

    // Hash probe weights
    const weightsPath = join(agentDir, "probe", "weights.pt");
    const probeHash = existsSync(weightsPath)
      ? this.hashFile(weightsPath)
      : null;

    const version: AgentVersion = {
      version: nextVersion,
      createdAt: new Date().toISOString(),
      changelog,
      manifest: {
        agentId: manifest.agentId,
        domain: manifest.domain,
        stratusModelVersion: manifest.stratusModelVersion,
        probeId: manifest.probe.primaryProbeId,
        hasCustomWeights: manifest.probe.hasCustomWeights,
        toolCount: manifest.tools.count,
        toolIds: manifest.tools.ids,
      },
      configHash,
      probeHash,
      status: "active",
    };

    // Mark previous active version as inactive
    for (const v of history.versions) {
      if (v.status === "active") v.status = "inactive";
    }

    // Store version snapshot (copy agent dir)
    const snapshotDir = join(this.versionsDir, agentId, nextVersion);
    mkdirSync(snapshotDir, { recursive: true });
    cpSync(agentDir, snapshotDir, { recursive: true });

    // Update history
    history.versions.push(version);
    history.currentVersion = nextVersion;
    this.saveHistory(agentId, history);

    return version;
  }

  /**
   * Rollback to a previous version.
   */
  rollback(agentId: string, targetVersion: string, agentDir: string): RollbackResult {
    const history = this.getHistory(agentId);
    const target = history.versions.find((v) => v.version === targetVersion);

    if (!target) {
      return {
        success: false,
        fromVersion: history.currentVersion,
        toVersion: targetVersion,
        error: `Version ${targetVersion} not found`,
      };
    }

    const snapshotDir = join(this.versionsDir, agentId, targetVersion);
    if (!existsSync(snapshotDir)) {
      return {
        success: false,
        fromVersion: history.currentVersion,
        toVersion: targetVersion,
        error: `Snapshot directory missing for ${targetVersion}`,
      };
    }

    const fromVersion = history.currentVersion;

    // Mark current as rolling-back, target as active
    for (const v of history.versions) {
      if (v.version === fromVersion) v.status = "inactive";
      if (v.version === targetVersion) v.status = "active";
    }

    // Restore snapshot to agent directory
    cpSync(snapshotDir, agentDir, { recursive: true });

    history.currentVersion = targetVersion;
    this.saveHistory(agentId, history);

    return { success: true, fromVersion, toVersion: targetVersion };
  }

  /**
   * Get the previous version (for quick rollback).
   */
  previousVersion(agentId: string): string | null {
    const history = this.getHistory(agentId);
    const idx = history.versions.findIndex(
      (v) => v.version === history.currentVersion,
    );
    return idx > 0 ? history.versions[idx - 1].version : null;
  }

  /**
   * Get version history for an agent.
   */
  getHistory(agentId: string): VersionHistory {
    const historyPath = join(this.versionsDir, agentId, "history.json");
    if (!existsSync(historyPath)) {
      return { agentId, currentVersion: "0.0.0", versions: [] };
    }
    return JSON.parse(readFileSync(historyPath, "utf-8"));
  }

  /**
   * Get blue/green deployment state for an agent.
   */
  getBlueGreenState(agentId: string): BlueGreenState {
    const statePath = join(this.versionsDir, agentId, "bluegreen.json");
    if (!existsSync(statePath)) {
      return {
        activeSlot: "blue",
        stagingSlot: "green",
        blueVersion: null,
        greenVersion: null,
      };
    }
    return JSON.parse(readFileSync(statePath, "utf-8"));
  }

  /**
   * Stage a version for blue/green cutover.
   */
  stageVersion(agentId: string, version: string): BlueGreenState {
    const state = this.getBlueGreenState(agentId);

    // Stage into the inactive slot
    if (state.activeSlot === "blue") {
      state.greenVersion = version;
      state.stagingSlot = "green";
    } else {
      state.blueVersion = version;
      state.stagingSlot = "blue";
    }

    this.saveBlueGreenState(agentId, state);
    return state;
  }

  /**
   * Cut over traffic to the staged version.
   */
  cutover(agentId: string): BlueGreenState {
    const state = this.getBlueGreenState(agentId);

    // Swap active and staging
    const prevActive = state.activeSlot;
    state.activeSlot = state.stagingSlot;
    state.stagingSlot = prevActive;

    this.saveBlueGreenState(agentId, state);
    return state;
  }

  /**
   * List all versions for an agent.
   */
  listVersions(agentId: string): AgentVersion[] {
    return this.getHistory(agentId).versions;
  }

  /**
   * Check if agent config has changed since last version.
   */
  hasChanges(agentId: string, agentDir: string): boolean {
    const history = this.getHistory(agentId);
    if (history.versions.length === 0) return true;

    const currentHash = this.hashFiles(agentDir, [
      "openclaw.json",
      "agent.tools.yaml",
      "AGENTS.md",
      "SOUL.md",
    ]);

    const lastVersion = history.versions[history.versions.length - 1];
    return currentHash !== lastVersion.configHash;
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  private saveHistory(agentId: string, history: VersionHistory): void {
    const dir = join(this.versionsDir, agentId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "history.json"), JSON.stringify(history, null, 2));
  }

  private saveBlueGreenState(agentId: string, state: BlueGreenState): void {
    const dir = join(this.versionsDir, agentId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bluegreen.json"), JSON.stringify(state, null, 2));
  }

  // -----------------------------------------------------------------------
  // Hashing
  // -----------------------------------------------------------------------

  private nextVersion(history: VersionHistory): string {
    if (history.versions.length === 0) return "1.0.0";

    const last = history.versions[history.versions.length - 1].version;
    const parts = last.split(".").map(Number);
    parts[2] += 1; // bump patch
    return parts.join(".");
  }

  private hashFiles(dir: string, files: string[]): string {
    const hash = createHash("sha256");
    for (const file of files) {
      const path = join(dir, file);
      if (existsSync(path)) {
        hash.update(readFileSync(path));
      }
    }
    return hash.digest("hex");
  }

  private hashFile(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  }
}
