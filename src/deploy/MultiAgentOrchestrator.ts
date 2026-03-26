/**
 * Multi-Agent Orchestrator — Run multiple agents sharing a single Stratus sidecar
 *
 * Manages agent routing based on channel/context, shares tool embedding
 * caches across agents in the same domain, and handles inter-agent
 * communication via OpenClaw session tools.
 *
 * @purpose Orchestrate multiple agents with shared sidecar and routing
 * @spec AGENT_FACTORY_SPEC.md#d24-multi-agent-deployment
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { AgentPackage, PackageManifest } from "../packaging/AgentPackage.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
  /** Agents participating in this deployment */
  agents: AgentSlot[];
  /** Shared sidecar URL */
  sidecarUrl: string;
  /** Routing rules */
  routing: RoutingRule[];
  /** Whether to share embedding caches across same-domain agents */
  shareEmbeddings?: boolean;
}

export interface AgentSlot {
  /** Agent ID */
  agentId: string;
  /** Package root directory */
  packageDir: string;
  /** Gateway port for this agent */
  port: number;
  /** Channels this agent handles */
  channels?: string[];
  /** Priority (higher = preferred for ambiguous routing) */
  priority?: number;
}

export interface RoutingRule {
  /** Rule type */
  type: "channel" | "domain" | "keyword" | "default";
  /** Match pattern */
  match: string;
  /** Target agent ID */
  targetAgentId: string;
}

export interface OrchestratorStatus {
  agents: AgentStatus[];
  sidecar: { healthy: boolean; url: string };
  sharedCaches: SharedCacheInfo[];
}

export interface AgentStatus {
  agentId: string;
  port: number;
  healthy: boolean;
  domain: string;
  channels: string[];
}

export interface SharedCacheInfo {
  domain: string;
  agentIds: string[];
  embeddingCount: number;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class MultiAgentOrchestrator {
  private config: OrchestratorConfig;
  private manifests: Map<string, PackageManifest> = new Map();

  constructor(config: OrchestratorConfig) {
    this.config = config;
  }

  /**
   * Initialize the orchestrator — load manifests, set up shared caches, configure routing.
   */
  async initialize(): Promise<{ ready: boolean; errors: string[] }> {
    const errors: string[] = [];

    // Load all agent manifests
    for (const slot of this.config.agents) {
      const manifestPath = join(slot.packageDir, ".stratus", "manifest.json");
      if (!existsSync(manifestPath)) {
        errors.push(`Agent ${slot.agentId}: no manifest found at ${manifestPath}`);
        continue;
      }

      try {
        const manifest = JSON.parse(
          readFileSync(manifestPath, "utf-8"),
        ) as PackageManifest;
        this.manifests.set(slot.agentId, manifest);
      } catch (err) {
        errors.push(`Agent ${slot.agentId}: invalid manifest — ${err}`);
      }
    }

    // Share embedding caches for same-domain agents
    if (this.config.shareEmbeddings !== false) {
      this.shareEmbeddingCaches();
    }

    // Verify sidecar health
    const sidecarHealthy = await this.checkSidecar();
    if (!sidecarHealthy) {
      errors.push(`Sidecar at ${this.config.sidecarUrl} is not responding`);
    }

    return { ready: errors.length === 0, errors };
  }

  /**
   * Route an incoming message to the appropriate agent.
   */
  route(context: {
    channel?: string;
    domain?: string;
    message?: string;
  }): AgentSlot | null {
    // Check explicit routing rules in order
    for (const rule of this.config.routing) {
      switch (rule.type) {
        case "channel":
          if (context.channel === rule.match) {
            return this.findAgent(rule.targetAgentId);
          }
          break;

        case "domain":
          if (context.domain === rule.match) {
            return this.findAgent(rule.targetAgentId);
          }
          break;

        case "keyword":
          if (context.message?.toLowerCase().includes(rule.match.toLowerCase())) {
            return this.findAgent(rule.targetAgentId);
          }
          break;

        case "default":
          return this.findAgent(rule.targetAgentId);
      }
    }

    // Fallback: highest priority agent
    const sorted = [...this.config.agents].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
    );
    return sorted[0] ?? null;
  }

  /**
   * Get status of all agents and shared resources.
   */
  async status(): Promise<OrchestratorStatus> {
    const agentStatuses: AgentStatus[] = [];

    for (const slot of this.config.agents) {
      const manifest = this.manifests.get(slot.agentId);
      let healthy = false;

      try {
        const resp = await fetch(`http://127.0.0.1:${slot.port}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        healthy = resp.ok;
      } catch {
        // unhealthy
      }

      agentStatuses.push({
        agentId: slot.agentId,
        port: slot.port,
        healthy,
        domain: manifest?.domain ?? "unknown",
        channels: slot.channels ?? [],
      });
    }

    const sidecarHealthy = await this.checkSidecar();

    // Compute shared cache info
    const domainAgents = new Map<string, string[]>();
    for (const [agentId, manifest] of this.manifests) {
      const existing = domainAgents.get(manifest.domain) ?? [];
      existing.push(agentId);
      domainAgents.set(manifest.domain, existing);
    }

    const sharedCaches: SharedCacheInfo[] = [];
    for (const [domain, agentIds] of domainAgents) {
      if (agentIds.length > 1) {
        const first = this.config.agents.find((a) => a.agentId === agentIds[0]);
        const manifest = this.manifests.get(agentIds[0]);
        sharedCaches.push({
          domain,
          agentIds,
          embeddingCount: manifest?.tools.count ?? 0,
        });
      }
    }

    return {
      agents: agentStatuses,
      sidecar: { healthy: sidecarHealthy, url: this.config.sidecarUrl },
      sharedCaches,
    };
  }

  /**
   * Generate docker-compose.yaml for this multi-agent configuration.
   */
  generateCompose(outputDir: string): string {
    mkdirSync(outputDir, { recursive: true });

    const sidecarPort = new URL(this.config.sidecarUrl).port || "7900";

    const agentServices = this.config.agents.map((slot) => {
      const manifest = this.manifests.get(slot.agentId);
      return `  ${slot.agentId}:
    build:
      context: ${slot.packageDir}
      dockerfile: Dockerfile
    container_name: stratus-${slot.agentId}
    ports:
      - "${slot.port}:18789"
    environment:
      - SIDECAR_URL=http://sidecar:${sidecarPort}
      - AGENT_ID=${slot.agentId}
      - AGENT_DOMAIN=${manifest?.domain ?? "general"}
    depends_on:
      sidecar:
        condition: service_healthy
    restart: unless-stopped`;
    }).join("\n\n");

    const routingEnv = this.config.routing
      .map((r, i) => `      - ROUTE_${i}_TYPE=${r.type}\n      - ROUTE_${i}_MATCH=${r.match}\n      - ROUTE_${i}_TARGET=${r.targetAgentId}`)
      .join("\n");

    const compose = `# Auto-generated Multi-Agent Deployment
version: "3.8"

services:
  sidecar:
    image: stratus-sidecar:latest
    container_name: stratus-sidecar-shared
    ports:
      - "${sidecarPort}:${sidecarPort}"
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:${sidecarPort}/health"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  router:
    image: stratus-router:latest
    container_name: stratus-router
    ports:
      - "8080:8080"
    environment:
${routingEnv}
    depends_on:
      - sidecar
    restart: unless-stopped

${agentServices}
`;

    const composePath = join(outputDir, "docker-compose.yaml");
    writeFileSync(composePath, compose);
    return composePath;
  }

  // -----------------------------------------------------------------------
  // Shared embedding caches
  // -----------------------------------------------------------------------

  private shareEmbeddingCaches(): void {
    // Group agents by domain
    const domainAgents = new Map<string, AgentSlot[]>();

    for (const slot of this.config.agents) {
      const manifest = this.manifests.get(slot.agentId);
      if (!manifest) continue;

      const existing = domainAgents.get(manifest.domain) ?? [];
      existing.push(slot);
      domainAgents.set(manifest.domain, existing);
    }

    // For each domain with multiple agents, copy embeddings from the one that has them
    for (const [, agents] of domainAgents) {
      if (agents.length < 2) continue;

      // Find agent with embeddings
      const source = agents.find((a) =>
        existsSync(join(a.packageDir, ".stratus", "tool_embeddings.bin")),
      );
      if (!source) continue;

      const embPath = join(source.packageDir, ".stratus", "tool_embeddings.bin");
      const embData = readFileSync(embPath);

      // Copy to agents that don't have embeddings
      for (const target of agents) {
        if (target.agentId === source.agentId) continue;

        const targetPath = join(target.packageDir, ".stratus", "tool_embeddings.bin");
        if (!existsSync(targetPath)) {
          const targetDir = join(target.packageDir, ".stratus");
          mkdirSync(targetDir, { recursive: true });
          writeFileSync(targetPath, embData);
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private findAgent(agentId: string): AgentSlot | null {
    return this.config.agents.find((a) => a.agentId === agentId) ?? null;
  }

  private async checkSidecar(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.config.sidecarUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }
}
