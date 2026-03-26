/**
 * Docker Deployer — Containerize agents with OpenClaw + Stratus sidecar
 *
 * Generates Dockerfile, docker-compose.yaml, and deployment artifacts
 * for running agents in containers. Supports GPU (nvidia-docker) and
 * CPU-only (ONNX runtime fallback) configurations.
 *
 * @purpose Generate Docker deployment artifacts for agent packages
 * @spec AGENT_FACTORY_SPEC.md#d22-docker-deployment
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentPackage } from "../packaging/AgentPackage.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DockerDeployOptions {
  /** Output directory for generated Docker files */
  outputDir: string;
  /** Whether to include GPU support (default: true) */
  gpuSupport?: boolean;
  /** Gateway port to expose (default: 18789) */
  gatewayPort?: number;
  /** Sidecar port (default: 7900) */
  sidecarPort?: number;
  /** Base image override */
  baseImage?: string;
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Whether to generate docker-compose.yaml */
  compose?: boolean;
}

export interface DockerDeployResult {
  /** Path to generated Dockerfile */
  dockerfilePath: string;
  /** Path to docker-compose.yaml (if generated) */
  composePath: string | null;
  /** Docker build command */
  buildCommand: string;
  /** Docker run command */
  runCommand: string;
}

// ---------------------------------------------------------------------------
// Deployer
// ---------------------------------------------------------------------------

export class DockerDeployer {
  private options: DockerDeployOptions;

  constructor(options: DockerDeployOptions) {
    this.options = options;
  }

  /**
   * Generate Docker deployment artifacts for an agent package.
   */
  generate(pkg: AgentPackage): DockerDeployResult {
    mkdirSync(this.options.outputDir, { recursive: true });

    const agentId = pkg.manifest.agentId;
    const gatewayPort = this.options.gatewayPort ?? 18789;
    const sidecarPort = this.options.sidecarPort ?? 7900;
    const gpu = this.options.gpuSupport !== false;

    // Generate Dockerfile
    const dockerfile = this.buildDockerfile(pkg, gpu, gatewayPort, sidecarPort);
    const dockerfilePath = join(this.options.outputDir, "Dockerfile");
    writeFileSync(dockerfilePath, dockerfile);

    // Generate docker-compose if requested
    let composePath: string | null = null;
    if (this.options.compose !== false) {
      const compose = this.buildCompose(agentId, gpu, gatewayPort, sidecarPort);
      composePath = join(this.options.outputDir, "docker-compose.yaml");
      writeFileSync(composePath, compose);
    }

    // Generate .dockerignore
    writeFileSync(
      join(this.options.outputDir, ".dockerignore"),
      DOCKERIGNORE,
    );

    // Generate entrypoint script
    writeFileSync(
      join(this.options.outputDir, "entrypoint.sh"),
      this.buildEntrypoint(sidecarPort),
    );

    const imageName = `stratus-agent-${agentId}`;
    const runtimeFlag = gpu ? "--gpus all " : "";

    return {
      dockerfilePath,
      composePath,
      buildCommand: `docker build -t ${imageName} -f ${dockerfilePath} .`,
      runCommand: `docker run ${runtimeFlag}-p ${gatewayPort}:${gatewayPort} -p ${sidecarPort}:${sidecarPort} ${imageName}`,
    };
  }

  /**
   * Generate docker-compose for multiple agents sharing a sidecar.
   */
  generateMultiAgent(
    packages: AgentPackage[],
  ): { composePath: string; buildCommands: string[] } {
    mkdirSync(this.options.outputDir, { recursive: true });

    const sidecarPort = this.options.sidecarPort ?? 7900;
    const gpu = this.options.gpuSupport !== false;
    const buildCommands: string[] = [];

    // Generate per-agent Dockerfiles
    for (const pkg of packages) {
      const agentDir = join(this.options.outputDir, pkg.manifest.agentId);
      mkdirSync(agentDir, { recursive: true });

      const df = this.buildAgentOnlyDockerfile(pkg);
      writeFileSync(join(agentDir, "Dockerfile"), df);
      buildCommands.push(
        `docker build -t stratus-agent-${pkg.manifest.agentId} -f ${agentDir}/Dockerfile .`,
      );
    }

    // Generate shared compose
    const compose = this.buildMultiAgentCompose(packages, gpu, sidecarPort);
    const composePath = join(this.options.outputDir, "docker-compose.yaml");
    writeFileSync(composePath, compose);

    return { composePath, buildCommands };
  }

  // -----------------------------------------------------------------------
  // Dockerfile generation
  // -----------------------------------------------------------------------

  private buildDockerfile(
    pkg: AgentPackage,
    gpu: boolean,
    gatewayPort: number,
    sidecarPort: number,
  ): string {
    const baseImage = this.options.baseImage ??
      (gpu ? "nvidia/cuda:12.1.0-runtime-ubuntu22.04" : "ubuntu:22.04");

    const envLines = Object.entries(this.options.env ?? {})
      .map(([k, v]) => `ENV ${k}="${v}"`)
      .join("\n");

    return `# Auto-generated by Stratus Agent Factory
# Agent: ${pkg.manifest.agentName} (${pkg.manifest.agentId})
# Domain: ${pkg.manifest.domain}

FROM ${baseImage}

# System dependencies
RUN apt-get update && apt-get install -y \\
    curl \\
    python3 \\
    python3-pip \\
    nodejs \\
    npm \\
    && rm -rf /var/lib/apt/lists/*

# Install OpenClaw
RUN npm install -g openclaw@latest

# Install Stratus sidecar
RUN pip3 install stratus-sidecar${gpu ? "[gpu]" : "[cpu]"}

# Working directory
WORKDIR /app/agent

# Copy agent package
COPY . /app/agent/

# Copy entrypoint
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

${envLines ? envLines + "\n" : ""}# Configure ports
ENV GATEWAY_PORT=${gatewayPort}
ENV SIDECAR_PORT=${sidecarPort}
ENV SIDECAR_URL=http://127.0.0.1:${sidecarPort}

EXPOSE ${gatewayPort}
EXPOSE ${sidecarPort}

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \\
    CMD curl -f http://localhost:${sidecarPort}/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
`;
  }

  private buildAgentOnlyDockerfile(pkg: AgentPackage): string {
    return `# Auto-generated — agent-only container (uses shared sidecar)
# Agent: ${pkg.manifest.agentName} (${pkg.manifest.agentId})

FROM node:22-slim

RUN npm install -g openclaw@latest

WORKDIR /app/agent
COPY . /app/agent/

ENV SIDECAR_URL=http://sidecar:7900

CMD ["openclaw", "gateway", "run", "--bind", "0.0.0.0"]
`;
  }

  // -----------------------------------------------------------------------
  // Docker Compose generation
  // -----------------------------------------------------------------------

  private buildCompose(
    agentId: string,
    gpu: boolean,
    gatewayPort: number,
    sidecarPort: number,
  ): string {
    const gpuBlock = gpu
      ? `    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]`
      : "";

    return `# Auto-generated by Stratus Agent Factory
version: "3.8"

services:
  agent:
    build: .
    container_name: stratus-${agentId}
    ports:
      - "${gatewayPort}:${gatewayPort}"
      - "${sidecarPort}:${sidecarPort}"
${gpuBlock}
    environment:
      - GATEWAY_PORT=${gatewayPort}
      - SIDECAR_PORT=${sidecarPort}
    restart: unless-stopped
    volumes:
      - agent-data:/app/agent/.stratus
      - agent-memory:/app/agent/memory

volumes:
  agent-data:
  agent-memory:
`;
  }

  private buildMultiAgentCompose(
    packages: AgentPackage[],
    gpu: boolean,
    sidecarPort: number,
  ): string {
    const gpuBlock = gpu
      ? `    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]`
      : "";

    const agentServices = packages.map((pkg, i) => {
      const port = 18789 + i;
      return `  ${pkg.manifest.agentId}:
    build:
      context: .
      dockerfile: ${pkg.manifest.agentId}/Dockerfile
    container_name: stratus-${pkg.manifest.agentId}
    ports:
      - "${port}:18789"
    environment:
      - SIDECAR_URL=http://sidecar:${sidecarPort}
    depends_on:
      sidecar:
        condition: service_healthy
    restart: unless-stopped
    volumes:
      - ${pkg.manifest.agentId}-data:/app/agent/.stratus`;
    }).join("\n\n");

    const volumes = packages
      .map((pkg) => `  ${pkg.manifest.agentId}-data:`)
      .join("\n");

    return `# Auto-generated by Stratus Agent Factory — Multi-agent deployment
version: "3.8"

services:
  sidecar:
    image: stratus-sidecar:latest
    container_name: stratus-sidecar
    ports:
      - "${sidecarPort}:${sidecarPort}"
${gpuBlock}
    environment:
      - PORT=${sidecarPort}
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:${sidecarPort}/health"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

${agentServices}

volumes:
${volumes}
`;
  }

  // -----------------------------------------------------------------------
  // Entrypoint
  // -----------------------------------------------------------------------

  private buildEntrypoint(sidecarPort: number): string {
    return `#!/bin/bash
set -e

echo "Starting Stratus sidecar on port ${sidecarPort}..."
stratus-sidecar --port ${sidecarPort} &
SIDECAR_PID=$!

# Wait for sidecar to be ready
for i in $(seq 1 30); do
    if curl -sf http://127.0.0.1:${sidecarPort}/health > /dev/null 2>&1; then
        echo "Sidecar ready."
        break
    fi
    if [ $i -eq 30 ]; then
        echo "WARNING: Sidecar did not start — running in LLM-only mode"
    fi
    sleep 1
done

echo "Starting OpenClaw Gateway..."
exec openclaw gateway run --bind 0.0.0.0 --port \${GATEWAY_PORT:-18789}
`;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOCKERIGNORE = `# Auto-generated
.git
.github
node_modules
*.log
.DS_Store
tests/results/
`;
