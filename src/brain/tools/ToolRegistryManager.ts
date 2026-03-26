/**
 * Tool Registry Manager
 *
 * Orchestrates tool discovery, conversion, embedding, and querying.
 * This is the top-level coordinator that the brain calls at startup
 * and when tools are hot-reloaded.
 *
 * Tool sources (loaded in order, later overrides earlier):
 * 1. OpenClaw skills directory (filesystem discovery via SkillToToolConverter)
 * 2. Agent-specific tool definitions (from agent config)
 * 3. Runtime-registered tools (via registerTool() at runtime)
 *
 * @purpose Top-level tool registry coordinator
 * @spec AGENT_FACTORY_SPEC.md#a35-build-tool-registry-manager
 */

import type { BrainToolDefinition } from "../IBrain.js";
import type { StratusClient } from "../stratus/index.js";
import { ToolEmbeddingCache } from "./ToolEmbeddingCache.js";
import { discoverSkills } from "./SkillToToolConverter.js";
import { entryToBrainTool, type ToolRegistryEntry, type OpenClawToolRegistration } from "./ToolRegistry.js";
import { convertToolRegistrations } from "./ToolRegistry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolRegistryManagerConfig {
  /** Path to OpenClaw extensions directory for skill discovery */
  extensionsDir?: string;
  /** Cache directory for embeddings (default: .stratus) */
  cacheDir?: string;
  /** Whether to pre-compute embeddings on load (default: true) */
  precomputeEmbeddings?: boolean;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class ToolRegistryManager {
  private tools = new Map<string, BrainToolDefinition>();
  private embeddings = new Map<string, number[]>();
  private embeddingCache: ToolEmbeddingCache;
  private config: ToolRegistryManagerConfig;

  constructor(config: ToolRegistryManagerConfig = {}) {
    this.config = config;
    this.embeddingCache = new ToolEmbeddingCache(config.cacheDir);
  }

  /**
   * Initialize the registry: discover tools, convert, and optionally pre-compute embeddings.
   */
  async initialize(
    client?: StratusClient,
    agentToolRegistrations?: OpenClawToolRegistration[],
    signal?: AbortSignal,
  ): Promise<void> {
    // Source 1: Filesystem discovery
    if (this.config.extensionsDir) {
      const discovered = discoverSkills(this.config.extensionsDir);
      for (const tool of discovered) {
        this.tools.set(tool.id, tool);
      }
    }

    // Source 2: Agent config registrations (overrides filesystem)
    if (agentToolRegistrations) {
      const converted = convertToolRegistrations(agentToolRegistrations);
      for (const tool of converted) {
        this.tools.set(tool.id, tool);
      }
    }

    // Pre-compute embeddings if client available
    if (client && this.config.precomputeEmbeddings !== false) {
      await this.computeEmbeddings(client, signal);
    }
  }

  // -----------------------------------------------------------------------
  // Registration (Source 3: Runtime)
  // -----------------------------------------------------------------------

  /**
   * Register a tool at runtime (e.g., from a plugin loaded after startup).
   * Invalidates its cached embedding so it gets recomputed on next access.
   */
  registerTool(tool: BrainToolDefinition): void {
    this.tools.set(tool.id, tool);
    this.embeddings.delete(tool.id);
    this.embeddingCache.invalidate([tool.id]);
  }

  /** Unregister a tool by ID. */
  unregisterTool(toolId: string): void {
    this.tools.delete(toolId);
    this.embeddings.delete(toolId);
    this.embeddingCache.invalidate([toolId]);
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /** Get all registered tools. */
  getAll(): BrainToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /** Get a tool by ID. */
  getById(toolId: string): BrainToolDefinition | undefined {
    return this.tools.get(toolId);
  }

  /** Get tools filtered by domain. */
  getByDomain(domain: string): BrainToolDefinition[] {
    return this.getAll().filter((t) => t.domain === domain);
  }

  /** Get all tool embedding vectors. Returns Map<toolId, embedding>. */
  getEmbeddings(): Map<string, number[]> {
    return new Map(this.embeddings);
  }

  /** Get embedding for a specific tool. */
  getEmbedding(toolId: string): number[] | undefined {
    return this.embeddings.get(toolId);
  }

  /** Number of registered tools. */
  get size(): number {
    return this.tools.size;
  }

  /** List all registered tool IDs. */
  toolIds(): string[] {
    return Array.from(this.tools.keys());
  }

  /** List all unique domains. */
  domains(): string[] {
    const domains = new Set<string>();
    for (const tool of this.tools.values()) {
      domains.add(tool.domain);
    }
    return Array.from(domains);
  }

  // -----------------------------------------------------------------------
  // Embeddings
  // -----------------------------------------------------------------------

  /**
   * Compute embeddings for all tools using the sidecar.
   * Uses the disk cache to avoid redundant encoding.
   */
  async computeEmbeddings(
    client: StratusClient,
    signal?: AbortSignal,
  ): Promise<void> {
    const tools = this.getAll();
    if (tools.length === 0) return;

    this.embeddings = await this.embeddingCache.getEmbeddings(tools, client, signal);
  }

  /**
   * Hot-reload: re-scan filesystem, diff against current registry,
   * register new tools, unregister removed ones, recompute changed embeddings.
   */
  async hotReload(
    client?: StratusClient,
    signal?: AbortSignal,
  ): Promise<{ added: string[]; removed: string[]; updated: string[] }> {
    if (!this.config.extensionsDir) {
      return { added: [], removed: [], updated: [] };
    }

    const freshTools = discoverSkills(this.config.extensionsDir);
    const freshMap = new Map(freshTools.map((t) => [t.id, t]));
    const currentIds = new Set(this.tools.keys());
    const freshIds = new Set(freshMap.keys());

    const added: string[] = [];
    const removed: string[] = [];
    const updated: string[] = [];

    // New tools
    for (const id of freshIds) {
      if (!currentIds.has(id)) {
        this.tools.set(id, freshMap.get(id)!);
        added.push(id);
      } else {
        const fresh = freshMap.get(id)!;
        const current = this.tools.get(id)!;
        if (fresh.rich_description !== current.rich_description) {
          this.tools.set(id, fresh);
          this.embeddingCache.invalidate([id]);
          updated.push(id);
        }
      }
    }

    // Removed tools (only filesystem-discovered ones)
    for (const id of currentIds) {
      if (!freshIds.has(id) && !this.isRuntimeRegistered(id)) {
        this.tools.delete(id);
        this.embeddings.delete(id);
        removed.push(id);
      }
    }

    // Recompute embeddings for changed tools
    if (client && (added.length > 0 || updated.length > 0)) {
      await this.computeEmbeddings(client, signal);
    }

    return { added, removed, updated };
  }

  // Track which tools were registered at runtime vs discovered
  private runtimeToolIds = new Set<string>();

  private isRuntimeRegistered(toolId: string): boolean {
    return this.runtimeToolIds.has(toolId);
  }
}
