/**
 * Fly.io Deployer — Deploy agents to Fly.io with GPU support
 *
 * Generates fly.toml, manages secrets, configures persistent volumes
 * for memory/state, and handles GPU machine allocation for Stratus inference.
 *
 * @purpose Generate Fly.io deployment configuration and manage cloud deployment
 * @spec AGENT_FACTORY_SPEC.md#d23-cloud-deployment
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

import type { AgentPackage } from "../packaging/AgentPackage.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FlyDeployOptions {
  /** Output directory for generated config */
  outputDir: string;
  /** Fly.io organization */
  org?: string;
  /** Fly.io region (default: iad) */
  region?: string;
  /** GPU machine type (default: a100-40gb) */
  gpuMachine?: string;
  /** CPU-only machine type (default: shared-cpu-2x) */
  cpuMachine?: string;
  /** Whether to use GPU machines (default: true) */
  gpu?: boolean;
  /** Volume size in GB for persistent state (default: 10) */
  volumeSize?: number;
  /** Auto-scaling min instances (default: 0) */
  minInstances?: number;
  /** Auto-scaling max instances (default: 2) */
  maxInstances?: number;
  /** Secrets to set (API keys, etc.) */
  secrets?: Record<string, string>;
}

export interface FlyDeployResult {
  /** Path to generated fly.toml */
  flyTomlPath: string;
  /** Path to generated Dockerfile */
  dockerfilePath: string;
  /** Fly app name */
  appName: string;
  /** Deploy command */
  deployCommand: string;
  /** Secrets set command */
  secretsCommand: string | null;
  /** Volume create command */
  volumeCommand: string;
}

// ---------------------------------------------------------------------------
// Deployer
// ---------------------------------------------------------------------------

export class FlyDeployer {
  private options: FlyDeployOptions;

  constructor(options: FlyDeployOptions) {
    this.options = options;
  }

  /**
   * Generate Fly.io deployment artifacts.
   */
  generate(pkg: AgentPackage): FlyDeployResult {
    mkdirSync(this.options.outputDir, { recursive: true });

    const agentId = pkg.manifest.agentId;
    const appName = `stratus-${agentId}`;
    const region = this.options.region ?? "iad";
    const gpu = this.options.gpu !== false;
    const volumeSize = this.options.volumeSize ?? 10;

    // Generate fly.toml
    const flyToml = this.buildFlyToml(pkg, appName, region, gpu);
    const flyTomlPath = join(this.options.outputDir, "fly.toml");
    writeFileSync(flyTomlPath, flyToml);

    // Generate Dockerfile (reuse Docker deployer pattern)
    const dockerfile = this.buildFlyDockerfile(pkg, gpu);
    const dockerfilePath = join(this.options.outputDir, "Dockerfile");
    writeFileSync(dockerfilePath, dockerfile);

    // Generate entrypoint
    writeFileSync(
      join(this.options.outputDir, "entrypoint.sh"),
      this.buildEntrypoint(),
    );

    // Build commands
    const secretsEntries = Object.entries(this.options.secrets ?? {});
    const secretsCommand = secretsEntries.length > 0
      ? `fly secrets set ${secretsEntries.map(([k, v]) => `${k}="${v}"`).join(" ")} -a ${appName}`
      : null;

    return {
      flyTomlPath,
      dockerfilePath,
      appName,
      deployCommand: `fly deploy -a ${appName} --region ${region}`,
      secretsCommand,
      volumeCommand: `fly volumes create agent_data --size ${volumeSize} --region ${region} -a ${appName}`,
    };
  }

  /**
   * Execute full deployment (requires fly CLI authenticated).
   */
  async deploy(pkg: AgentPackage): Promise<{
    success: boolean;
    appUrl: string | null;
    error: string | null;
  }> {
    const result = this.generate(pkg);

    try {
      // Create app
      this.exec(`fly apps create ${result.appName} --org ${this.options.org ?? "personal"}`);

      // Create volume
      this.exec(result.volumeCommand);

      // Set secrets
      if (result.secretsCommand) {
        this.exec(result.secretsCommand);
      }

      // Deploy
      this.exec(result.deployCommand, { cwd: this.options.outputDir });

      const appUrl = `https://${result.appName}.fly.dev`;
      return { success: true, appUrl, error: null };
    } catch (err) {
      return {
        success: false,
        appUrl: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // -----------------------------------------------------------------------
  // fly.toml generation
  // -----------------------------------------------------------------------

  private buildFlyToml(
    pkg: AgentPackage,
    appName: string,
    region: string,
    gpu: boolean,
  ): string {
    const machine = gpu
      ? (this.options.gpuMachine ?? "a100-40gb")
      : (this.options.cpuMachine ?? "shared-cpu-2x");

    const minInstances = this.options.minInstances ?? 0;
    const maxInstances = this.options.maxInstances ?? 2;

    return `# Auto-generated by Stratus Agent Factory
# Agent: ${pkg.manifest.agentName} (${pkg.manifest.agentId})
# Domain: ${pkg.manifest.domain}

app = "${appName}"
primary_region = "${region}"

[build]
  dockerfile = "Dockerfile"

[env]
  GATEWAY_PORT = "18789"
  SIDECAR_PORT = "7900"
  SIDECAR_URL = "http://127.0.0.1:7900"
  NODE_ENV = "production"

[http_service]
  internal_port = 18789
  force_https = true
  auto_stop_machines = ${minInstances === 0 ? "\"stop\"" : "\"off\""}
  auto_start_machines = true
  min_machines_running = ${minInstances}

  [http_service.concurrency]
    type = "requests"
    hard_limit = 50
    soft_limit = 25

[[vm]]
  size = "${machine}"
  memory = "${gpu ? "16gb" : "2gb"}"

[mounts]
  source = "agent_data"
  destination = "/data"

[checks]
  [checks.sidecar]
    port = 7900
    type = "http"
    interval = "15s"
    timeout = "5s"
    path = "/health"

  [checks.gateway]
    port = 18789
    type = "http"
    interval = "15s"
    timeout = "5s"
    path = "/health"

[[services]]
  protocol = "tcp"
  internal_port = 18789

  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]

[metrics]
  port = 9090
  path = "/metrics"
`;
  }

  // -----------------------------------------------------------------------
  // Dockerfile for Fly
  // -----------------------------------------------------------------------

  private buildFlyDockerfile(pkg: AgentPackage, gpu: boolean): string {
    const baseImage = gpu
      ? "nvidia/cuda:12.1.0-runtime-ubuntu22.04"
      : "ubuntu:22.04";

    return `# Auto-generated for Fly.io deployment
# Agent: ${pkg.manifest.agentName} (${pkg.manifest.agentId})

FROM ${baseImage}

RUN apt-get update && apt-get install -y \\
    curl \\
    python3 \\
    python3-pip \\
    nodejs \\
    npm \\
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g openclaw@latest
RUN pip3 install stratus-sidecar${gpu ? "[gpu]" : "[cpu]"}

WORKDIR /app/agent
COPY . /app/agent/

# Persistent data mount
RUN mkdir -p /data/memory /data/traces /data/cache

# Link persistent dirs
RUN ln -sf /data/memory /app/agent/memory && \\
    ln -sf /data/traces /app/agent/.stratus/traces && \\
    ln -sf /data/cache /app/agent/.stratus/cache

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

EXPOSE 18789 7900

ENTRYPOINT ["/app/entrypoint.sh"]
`;
  }

  // -----------------------------------------------------------------------
  // Entrypoint
  // -----------------------------------------------------------------------

  private buildEntrypoint(): string {
    return `#!/bin/bash
set -e

echo "Starting Stratus sidecar..."
stratus-sidecar --port \${SIDECAR_PORT:-7900} &
SIDECAR_PID=$!

for i in $(seq 1 30); do
    if curl -sf http://127.0.0.1:\${SIDECAR_PORT:-7900}/health > /dev/null 2>&1; then
        echo "Sidecar ready."
        break
    fi
    [ $i -eq 30 ] && echo "WARNING: Sidecar not ready — continuing anyway"
    sleep 1
done

echo "Starting OpenClaw Gateway..."
exec openclaw gateway run --bind 0.0.0.0 --port \${GATEWAY_PORT:-18789}
`;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private exec(cmd: string, opts?: { cwd?: string }): string {
    return execSync(cmd, {
      stdio: "pipe",
      timeout: 120_000,
      cwd: opts?.cwd,
    }).toString();
  }
}
