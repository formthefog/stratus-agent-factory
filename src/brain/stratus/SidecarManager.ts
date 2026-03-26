/**
 * Sidecar Lifecycle Manager
 *
 * Manages the Stratus sidecar Python process: auto-start, health monitoring,
 * restart on failure, and graceful shutdown.
 *
 * @purpose Lifecycle management for the Stratus sidecar process
 * @spec AGENT_FACTORY_SPEC.md#b15-build-sidecar-lifecycle-manager
 */

import { spawn, type ChildProcess } from "node:child_process";
import { StratusClient, StratusClientError } from "./StratusClient.js";
import type { HealthResponse } from "./StratusRPC.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SidecarManagerConfig {
  /** Path to the sidecar server.py (default: auto-detect from STRATUS_MODEL_PATH) */
  sidecarScript?: string;
  /** Host to bind sidecar (default: 127.0.0.1) */
  host: string;
  /** Port for sidecar (default: 8100) */
  port: number;
  /** Path to Python executable (default: python3) */
  pythonPath: string;
  /** Model checkpoint path (default: env STRATUS_CHECKPOINT) */
  checkpointPath?: string;
  /** Max time to wait for sidecar startup in ms (default: 60000) */
  startupTimeoutMs: number;
  /** Health check interval in ms (default: 30000) */
  healthCheckIntervalMs: number;
  /** Max consecutive health check failures before restart (default: 3) */
  maxHealthFailures: number;
  /** Enable auto-restart on failure (default: true) */
  autoRestart: boolean;
  /** Max auto-restart attempts (default: 3) */
  maxRestartAttempts: number;
  /** Enable dev mode (hot-reload in sidecar) (default: false) */
  devMode: boolean;
}

const DEFAULT_CONFIG: SidecarManagerConfig = {
  host: "127.0.0.1",
  port: 8100,
  pythonPath: "python3",
  startupTimeoutMs: 60_000,
  healthCheckIntervalMs: 30_000,
  maxHealthFailures: 3,
  autoRestart: true,
  maxRestartAttempts: 3,
  devMode: false,
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type SidecarStatus =
  | "stopped"
  | "starting"
  | "running"
  | "unhealthy"
  | "restarting"
  | "failed";

export interface SidecarState {
  status: SidecarStatus;
  pid?: number;
  lastHealth?: HealthResponse;
  lastHealthCheck?: Date;
  consecutiveFailures: number;
  restartCount: number;
  startedAt?: Date;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class SidecarManager {
  private config: SidecarManagerConfig;
  private client: StratusClient;
  private process: ChildProcess | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private state: SidecarState = {
    status: "stopped",
    consecutiveFailures: 0,
    restartCount: 0,
  };

  constructor(
    config?: Partial<SidecarManagerConfig>,
    client?: StratusClient,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.client =
      client ??
      new StratusClient({
        baseUrl: `http://${this.config.host}:${this.config.port}`,
      });
  }

  /** Current sidecar state (readonly copy). */
  getState(): Readonly<SidecarState> {
    return { ...this.state };
  }

  // -----------------------------------------------------------------------
  // Startup
  // -----------------------------------------------------------------------

  /**
   * Start the sidecar process and wait until it's healthy.
   * If a sidecar is already running on the configured port, attaches to it.
   */
  async start(): Promise<void> {
    // Check if already running externally
    if (await this.isExternalSidecarRunning()) {
      this.state.status = "running";
      this.startHealthMonitor();
      return;
    }

    this.state.status = "starting";
    this.state.restartCount = 0;
    await this.spawnSidecar();
  }

  private async spawnSidecar(): Promise<void> {
    const scriptPath = this.resolveSidecarScript();
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      STRATUS_SIDECAR_HOST: this.config.host,
      STRATUS_SIDECAR_PORT: String(this.config.port),
    };

    if (this.config.checkpointPath) {
      env.STRATUS_CHECKPOINT = this.config.checkpointPath;
    }
    if (this.config.devMode) {
      env.STRATUS_DEV = "1";
    }

    this.process = spawn(this.config.pythonPath, [scriptPath], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    this.process.on("exit", (code, signal) => {
      if (this.state.status === "running" || this.state.status === "starting") {
        console.error(
          `[sidecar] Process exited unexpectedly (code=${code}, signal=${signal})`,
        );
        this.state.status = "failed";
        this.handleUnexpectedExit();
      }
    });

    // Log stderr for diagnostics
    this.process.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.error(`[sidecar:stderr] ${line}`);
    });

    this.state.pid = this.process.pid;
    this.state.startedAt = new Date();

    // Wait for sidecar to become healthy
    await this.waitForHealthy();
    this.state.status = "running";
    this.startHealthMonitor();
  }

  private resolveSidecarScript(): string {
    if (this.config.sidecarScript) return this.config.sidecarScript;

    // Default: look relative to this module or via env
    const modelPath = process.env.STRATUS_MODEL_PATH;
    if (modelPath) {
      return `${modelPath}/../stratus_sidecar/server.py`;
    }
    // Fallback: assume sidecar is alongside the model code
    return "stratus_sidecar/server.py";
  }

  private async waitForHealthy(): Promise<void> {
    const start = Date.now();
    const pollMs = 500;

    while (Date.now() - start < this.config.startupTimeoutMs) {
      try {
        const health = await this.client.health(AbortSignal.timeout(2_000));
        this.state.lastHealth = health;
        this.state.lastHealthCheck = new Date();
        return;
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }

    // Timed out — kill the process
    this.killProcess();
    throw new Error(
      `Sidecar failed to become healthy within ${this.config.startupTimeoutMs}ms`,
    );
  }

  private async isExternalSidecarRunning(): Promise<boolean> {
    try {
      const health = await this.client.health(AbortSignal.timeout(2_000));
      this.state.lastHealth = health;
      this.state.lastHealthCheck = new Date();
      return true;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Health Monitoring
  // -----------------------------------------------------------------------

  private startHealthMonitor(): void {
    this.stopHealthMonitor();
    this.healthTimer = setInterval(
      () => void this.checkHealth(),
      this.config.healthCheckIntervalMs,
    );
  }

  private stopHealthMonitor(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private async checkHealth(): Promise<void> {
    try {
      const health = await this.client.health(AbortSignal.timeout(5_000));
      this.state.lastHealth = health;
      this.state.lastHealthCheck = new Date();
      this.state.consecutiveFailures = 0;

      if (this.state.status === "unhealthy") {
        this.state.status = "running";
      }
    } catch (err) {
      this.state.consecutiveFailures++;
      console.warn(
        `[sidecar] Health check failed (${this.state.consecutiveFailures}/${this.config.maxHealthFailures}): ${err instanceof Error ? err.message : err}`,
      );

      if (this.state.consecutiveFailures >= this.config.maxHealthFailures) {
        this.state.status = "unhealthy";
        if (this.config.autoRestart) {
          void this.attemptRestart();
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Restart
  // -----------------------------------------------------------------------

  private async handleUnexpectedExit(): Promise<void> {
    this.stopHealthMonitor();
    if (this.config.autoRestart) {
      await this.attemptRestart();
    }
  }

  private async attemptRestart(): Promise<void> {
    if (this.state.restartCount >= this.config.maxRestartAttempts) {
      this.state.status = "failed";
      console.error(
        `[sidecar] Max restart attempts (${this.config.maxRestartAttempts}) exceeded. Giving up.`,
      );
      return;
    }

    this.state.status = "restarting";
    this.state.restartCount++;
    this.killProcess();

    console.warn(
      `[sidecar] Restarting (attempt ${this.state.restartCount}/${this.config.maxRestartAttempts})...`,
    );

    // Brief delay before restart
    await new Promise((r) => setTimeout(r, 1_000));

    try {
      await this.spawnSidecar();
    } catch (err) {
      console.error(`[sidecar] Restart failed: ${err instanceof Error ? err.message : err}`);
      this.state.status = "failed";
    }
  }

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  /** Gracefully stop the sidecar. */
  async stop(): Promise<void> {
    this.stopHealthMonitor();

    if (this.process && !this.process.killed) {
      // Send SIGTERM for graceful shutdown
      this.process.kill("SIGTERM");

      // Wait up to 5s for graceful exit
      const exited = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 5_000);
        this.process?.on("exit", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });

      if (!exited) {
        this.killProcess();
      }
    }

    this.process = null;
    this.state.status = "stopped";
    this.state.pid = undefined;
  }

  private killProcess(): void {
    if (this.process && !this.process.killed) {
      this.process.kill("SIGKILL");
    }
  }

  // -----------------------------------------------------------------------
  // Hot Reload
  // -----------------------------------------------------------------------

  /** Hot-reload the model checkpoint without restarting the sidecar. */
  async reloadModel(checkpointPath?: string): Promise<void> {
    if (this.state.status !== "running") {
      throw new Error(`Cannot reload: sidecar is ${this.state.status}`);
    }
    const result = await this.client.reload(checkpointPath);
    if (!result.success) {
      throw new Error("Model reload failed on sidecar");
    }
    // Refresh health to update model_version
    try {
      this.state.lastHealth = await this.client.health();
    } catch {
      // Non-critical
    }
  }
}
