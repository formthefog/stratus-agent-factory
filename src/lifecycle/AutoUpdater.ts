/**
 * Auto-Updater — Safely update agents when Stratus model changes
 *
 * When a new Stratus checkpoint is deployed, the auto-updater:
 * 1. Loads the new model in the sidecar
 * 2. Re-embeds all tools with the new ActionEncoder
 * 3. Runs smoke tests against the new embeddings
 * 4. Swaps to the new model if tests pass
 * 5. Rolls back if tests fail
 *
 * This is the mechanism that keeps all deployed agents compatible
 * with the latest world model — critical for the flywheel.
 *
 * @purpose Safely update agents when Stratus model version changes
 * @spec AGENT_FACTORY_SPEC.md#d33-build-agent-auto-updater
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutoUpdaterConfig {
  /** Sidecar URL */
  sidecarUrl: string;
  /** Agent package directory */
  agentDir: string;
  /** Test runner function — runs smoke tests, returns pass rate */
  testRunner: (agentDir: string) => Promise<{ passRate: number; details: string }>;
  /** Version manager for rollback support */
  versionManager?: {
    createVersion: (agentDir: string, changelog: string) => unknown;
    rollback: (agentId: string, version: string, agentDir: string) => { success: boolean };
    previousVersion: (agentId: string) => string | null;
  };
  /** Minimum test pass rate to proceed with update (default: 0.8) */
  minPassRate?: number;
  /** Whether to auto-rollback on failure (default: true) */
  autoRollback?: boolean;
  /** Callback for progress updates */
  onProgress?: (step: UpdateStep) => void;
}

export interface UpdateStep {
  phase: UpdatePhase;
  status: "started" | "completed" | "failed";
  message: string;
  timestamp: string;
}

export type UpdatePhase =
  | "check_version"
  | "load_model"
  | "re_embed_tools"
  | "smoke_test"
  | "swap_model"
  | "rollback";

export interface UpdateResult {
  success: boolean;
  fromVersion: string;
  toVersion: string;
  steps: UpdateStep[];
  testPassRate: number | null;
  error?: string;
}

export interface ModelVersionInfo {
  currentVersion: string;
  availableVersion: string;
  updateAvailable: boolean;
}

// ---------------------------------------------------------------------------
// Updater
// ---------------------------------------------------------------------------

export class AutoUpdater {
  private config: AutoUpdaterConfig;
  private minPassRate: number;

  constructor(config: AutoUpdaterConfig) {
    this.config = config;
    this.minPassRate = config.minPassRate ?? 0.8;
  }

  /**
   * Check if an update is available.
   */
  async checkForUpdate(): Promise<ModelVersionInfo> {
    const currentVersion = this.getCurrentModelVersion();

    try {
      const resp = await fetch(`${this.config.sidecarUrl}/model/version`, {
        signal: AbortSignal.timeout(5000),
      });

      if (!resp.ok) {
        return {
          currentVersion,
          availableVersion: currentVersion,
          updateAvailable: false,
        };
      }

      const data = await resp.json();
      const availableVersion = data.latest_version ?? data.version ?? currentVersion;

      return {
        currentVersion,
        availableVersion,
        updateAvailable: availableVersion !== currentVersion,
      };
    } catch {
      return {
        currentVersion,
        availableVersion: currentVersion,
        updateAvailable: false,
      };
    }
  }

  /**
   * Execute the full update pipeline.
   */
  async update(targetVersion?: string): Promise<UpdateResult> {
    const steps: UpdateStep[] = [];
    const fromVersion = this.getCurrentModelVersion();

    const emit = (phase: UpdatePhase, status: UpdateStep["status"], message: string) => {
      const step: UpdateStep = {
        phase,
        status,
        message,
        timestamp: new Date().toISOString(),
      };
      steps.push(step);
      this.config.onProgress?.(step);
    };

    // Step 1: Check version
    emit("check_version", "started", "Checking for model update...");
    const versionInfo = await this.checkForUpdate();
    const toVersion = targetVersion ?? versionInfo.availableVersion;

    if (!targetVersion && !versionInfo.updateAvailable) {
      emit("check_version", "completed", `Already on latest: ${fromVersion}`);
      return {
        success: true,
        fromVersion,
        toVersion: fromVersion,
        steps,
        testPassRate: null,
      };
    }
    emit("check_version", "completed", `Update available: ${fromVersion} → ${toVersion}`);

    // Create pre-update version snapshot
    if (this.config.versionManager) {
      this.config.versionManager.createVersion(
        this.config.agentDir,
        `Pre-update snapshot (before ${toVersion})`,
      );
    }

    // Step 2: Load new model in sidecar
    emit("load_model", "started", `Loading model ${toVersion}...`);
    try {
      const loadResp = await fetch(`${this.config.sidecarUrl}/model/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: toVersion }),
        signal: AbortSignal.timeout(120_000), // Model loading can be slow
      });

      if (!loadResp.ok) {
        const err = await loadResp.text();
        emit("load_model", "failed", `Failed to load model: ${err}`);
        return this.handleFailure(fromVersion, toVersion, steps, err);
      }
      emit("load_model", "completed", `Model ${toVersion} loaded`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emit("load_model", "failed", `Model load error: ${msg}`);
      return this.handleFailure(fromVersion, toVersion, steps, msg);
    }

    // Step 3: Re-embed all tools
    emit("re_embed_tools", "started", "Re-embedding tools with new ActionEncoder...");
    try {
      await this.reEmbedTools();
      emit("re_embed_tools", "completed", "Tool embeddings updated");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emit("re_embed_tools", "failed", `Re-embedding failed: ${msg}`);
      return this.handleFailure(fromVersion, toVersion, steps, msg);
    }

    // Step 4: Run smoke tests
    emit("smoke_test", "started", "Running smoke tests...");
    let testPassRate: number;
    try {
      const testResult = await this.config.testRunner(this.config.agentDir);
      testPassRate = testResult.passRate;

      if (testPassRate < this.minPassRate) {
        emit(
          "smoke_test",
          "failed",
          `Tests failed: ${(testPassRate * 100).toFixed(1)}% pass rate (need ${(this.minPassRate * 100).toFixed(1)}%). ${testResult.details}`,
        );
        return this.handleFailure(fromVersion, toVersion, steps, "Smoke tests below threshold", testPassRate);
      }

      emit("smoke_test", "completed", `Tests passed: ${(testPassRate * 100).toFixed(1)}% pass rate`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emit("smoke_test", "failed", `Test runner error: ${msg}`);
      return this.handleFailure(fromVersion, toVersion, steps, msg);
    }

    // Step 5: Swap to new model (update manifest)
    emit("swap_model", "started", "Finalizing update...");
    this.updateManifestVersion(toVersion);

    if (this.config.versionManager) {
      this.config.versionManager.createVersion(
        this.config.agentDir,
        `Updated to Stratus ${toVersion} (pass rate: ${(testPassRate * 100).toFixed(1)}%)`,
      );
    }

    emit("swap_model", "completed", `Update complete: now running ${toVersion}`);

    return {
      success: true,
      fromVersion,
      toVersion,
      steps,
      testPassRate,
    };
  }

  // -----------------------------------------------------------------------
  // Re-embedding
  // -----------------------------------------------------------------------

  private async reEmbedTools(): Promise<void> {
    const toolsPath = join(this.config.agentDir, "agent.tools.yaml");
    if (!existsSync(toolsPath)) return;

    const content = readFileSync(toolsPath, "utf-8");

    // Extract rich descriptions
    const descriptions: string[] = [];
    for (const line of content.split("\n")) {
      const match = line.match(/rich_description:\s*"(.+)"/);
      if (match) descriptions.push(match[1]);
    }

    if (descriptions.length === 0) return;

    const resp = await fetch(`${this.config.sidecarUrl}/encode_actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action_texts: descriptions }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      throw new Error(`Embedding request failed: ${resp.status}`);
    }

    const result = await resp.json();
    if (!result.embeddings) {
      throw new Error("No embeddings in response");
    }

    // Write new embeddings cache
    const flat = (result.embeddings as number[][]).flat();
    const buffer = Buffer.from(new Float32Array(flat).buffer);
    const stratusDir = join(this.config.agentDir, ".stratus");
    mkdirSync(stratusDir, { recursive: true });
    writeFileSync(join(stratusDir, "tool_embeddings.bin"), buffer);
  }

  // -----------------------------------------------------------------------
  // Failure handling
  // -----------------------------------------------------------------------

  private async handleFailure(
    fromVersion: string,
    toVersion: string,
    steps: UpdateStep[],
    error: string,
    testPassRate?: number,
  ): Promise<UpdateResult> {
    if (this.config.autoRollback !== false && this.config.versionManager) {
      const prevVersion = this.config.versionManager.previousVersion(
        this.getAgentId(),
      );

      if (prevVersion) {
        const emit = (phase: UpdatePhase, status: UpdateStep["status"], msg: string) => {
          steps.push({ phase, status, message: msg, timestamp: new Date().toISOString() });
          this.config.onProgress?.({ phase, status, message: msg, timestamp: new Date().toISOString() });
        };

        emit("rollback", "started", `Rolling back to ${prevVersion}...`);

        const result = this.config.versionManager.rollback(
          this.getAgentId(),
          prevVersion,
          this.config.agentDir,
        );

        if (result.success) {
          // Reload previous model in sidecar
          try {
            await fetch(`${this.config.sidecarUrl}/model/load`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ version: fromVersion }),
              signal: AbortSignal.timeout(120_000),
            });
          } catch {
            // Best effort — sidecar may still have old model cached
          }

          emit("rollback", "completed", `Rolled back to ${prevVersion}`);
        } else {
          emit("rollback", "failed", "Rollback failed — manual intervention required");
        }
      }
    }

    return {
      success: false,
      fromVersion,
      toVersion,
      steps,
      testPassRate: testPassRate ?? null,
      error,
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private getCurrentModelVersion(): string {
    const manifestPath = join(this.config.agentDir, ".stratus", "manifest.json");
    if (!existsSync(manifestPath)) return "unknown";

    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      return manifest.stratusModelVersion ?? "unknown";
    } catch {
      return "unknown";
    }
  }

  private getAgentId(): string {
    const manifestPath = join(this.config.agentDir, ".stratus", "manifest.json");
    if (!existsSync(manifestPath)) return "unknown";

    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      return manifest.agentId ?? "unknown";
    } catch {
      return "unknown";
    }
  }

  private updateManifestVersion(newVersion: string): void {
    const manifestPath = join(this.config.agentDir, ".stratus", "manifest.json");
    if (!existsSync(manifestPath)) return;

    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    manifest.stratusModelVersion = newVersion;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
}
