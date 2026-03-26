/**
 * Local Deployer — Install agents to the local OpenClaw environment
 *
 * Copies a validated agent package to ~/.openclaw/agents/<name>/,
 * registers it with the local Gateway, and ensures the Stratus sidecar
 * is running (shared or per-agent).
 *
 * @purpose Deploy agent packages to local OpenClaw installation
 * @spec AGENT_FACTORY_SPEC.md#d21-local-deployment
 */

import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { execSync, spawn } from "node:child_process";

import type { AgentPackage } from "../packaging/AgentPackage.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LocalDeployOptions {
  /** Override install directory (default: ~/.openclaw/agents/) */
  agentsDir?: string;
  /** Whether to start sidecar if not running */
  ensureSidecar?: boolean;
  /** Sidecar port (default: 7900) */
  sidecarPort?: number;
  /** Whether this agent gets its own sidecar (vs shared) */
  dedicatedSidecar?: boolean;
  /** Gateway registration command override */
  gatewayRegisterCmd?: string;
}

export interface LocalDeployResult {
  /** Where the agent was installed */
  installDir: string;
  /** Whether the agent was registered with Gateway */
  gatewayRegistered: boolean;
  /** Whether sidecar is running */
  sidecarRunning: boolean;
  /** Sidecar URL for this agent */
  sidecarUrl: string;
  /** Any warnings during deployment */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Deployer
// ---------------------------------------------------------------------------

export class LocalDeployer {
  private options: LocalDeployOptions;
  private agentsBaseDir: string;

  constructor(options: LocalDeployOptions = {}) {
    this.options = options;
    this.agentsBaseDir = options.agentsDir ??
      join(homedir(), ".openclaw", "agents");
  }

  /**
   * Deploy an agent package to the local environment.
   */
  async deploy(pkg: AgentPackage): Promise<LocalDeployResult> {
    const warnings: string[] = [];
    const agentId = pkg.manifest.agentId;
    const installDir = join(this.agentsBaseDir, agentId);

    // 1. Create install directory
    mkdirSync(installDir, { recursive: true });

    // 2. Copy package contents
    cpSync(pkg.rootDir, installDir, { recursive: true });

    // 3. Check/start sidecar
    const sidecarPort = this.options.sidecarPort ?? 7900;
    const sidecarUrl = `http://127.0.0.1:${sidecarPort}`;
    let sidecarRunning = await this.isSidecarRunning(sidecarUrl);

    if (!sidecarRunning && this.options.ensureSidecar !== false) {
      sidecarRunning = await this.startSidecar(sidecarPort);
      if (!sidecarRunning) {
        warnings.push("Could not start Stratus sidecar — agent will fall back to LLM-only mode");
      }
    }

    // 4. Write sidecar config for this agent
    const stratusDir = join(installDir, ".stratus");
    mkdirSync(stratusDir, { recursive: true });
    writeFileSync(
      join(stratusDir, "runtime.json"),
      JSON.stringify({
        sidecarUrl,
        dedicated: this.options.dedicatedSidecar ?? false,
        sidecarPort,
      }, null, 2),
    );

    // 5. Register with Gateway
    let gatewayRegistered = false;
    try {
      gatewayRegistered = this.registerWithGateway(agentId, installDir);
    } catch {
      warnings.push("Could not register with Gateway — agent installed but not routable");
    }

    return {
      installDir,
      gatewayRegistered,
      sidecarRunning,
      sidecarUrl,
      warnings,
    };
  }

  /**
   * Uninstall a locally deployed agent.
   */
  uninstall(agentId: string): { removed: boolean; warnings: string[] } {
    const warnings: string[] = [];
    const installDir = join(this.agentsBaseDir, agentId);

    if (!existsSync(installDir)) {
      return { removed: false, warnings: ["Agent not found locally"] };
    }

    // Deregister from Gateway
    try {
      this.deregisterFromGateway(agentId);
    } catch {
      warnings.push("Could not deregister from Gateway");
    }

    // Remove directory
    cpSync(installDir, `${installDir}.bak`, { recursive: true }); // backup first
    const { rmSync } = require("node:fs");
    rmSync(installDir, { recursive: true, force: true });

    return { removed: true, warnings };
  }

  /**
   * List locally installed agents.
   */
  listInstalled(): string[] {
    if (!existsSync(this.agentsBaseDir)) return [];

    const { readdirSync } = require("node:fs");
    return readdirSync(this.agentsBaseDir, { withFileTypes: true })
      .filter((e: { isDirectory(): boolean }) => e.isDirectory())
      .map((e: { name: string }) => e.name);
  }

  // -----------------------------------------------------------------------
  // Sidecar management
  // -----------------------------------------------------------------------

  private async isSidecarRunning(url: string): Promise<boolean> {
    try {
      const response = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async startSidecar(port: number): Promise<boolean> {
    try {
      // Attempt to start sidecar as background process
      const child = spawn("stratus-sidecar", ["--port", String(port)], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      // Wait for startup
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (await this.isSidecarRunning(`http://127.0.0.1:${port}`)) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Gateway registration
  // -----------------------------------------------------------------------

  private registerWithGateway(agentId: string, installDir: string): boolean {
    const cmd = this.options.gatewayRegisterCmd ??
      `openclaw agent register --id ${agentId} --path ${installDir}`;

    try {
      execSync(cmd, { stdio: "pipe", timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  private deregisterFromGateway(agentId: string): void {
    try {
      execSync(`openclaw agent unregister --id ${agentId}`, {
        stdio: "pipe",
        timeout: 10_000,
      });
    } catch {
      // Best effort
    }
  }
}
