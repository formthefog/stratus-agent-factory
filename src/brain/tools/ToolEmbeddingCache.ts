/**
 * Tool Embedding Cache
 *
 * Caches action encoder embeddings for tool rich_descriptions to disk.
 * On agent startup, encodes all tools via the sidecar's /encode_actions endpoint,
 * then caches the results. Invalidates when skill manifests change (hash-based).
 *
 * Cache format: JSON file at .stratus/tool_embeddings.json
 * Each entry: { richDescription, hash, embedding, dim, cachedAt }
 *
 * @purpose Disk-based embedding cache for tool action descriptions
 * @spec AGENT_FACTORY_SPEC.md#a34-build-tool-embedding-cache
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { BrainToolDefinition } from "../IBrain.js";
import type { StratusClient } from "../stratus/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CachedEmbedding {
  toolId: string;
  hash: string;
  embedding: number[];
  dim: number;
  cachedAt: string;
}

interface CacheFile {
  version: 1;
  entries: Record<string, CachedEmbedding>;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export class ToolEmbeddingCache {
  private cachePath: string;
  private cache: CacheFile;

  constructor(cacheDir = ".stratus") {
    this.cachePath = join(cacheDir, "tool_embeddings.json");
    this.cache = this.loadFromDisk();
  }

  /**
   * Get embeddings for all tools, encoding uncached ones via the sidecar.
   * Returns a Map from tool ID to embedding vector.
   */
  async getEmbeddings(
    tools: BrainToolDefinition[],
    client: StratusClient,
    signal?: AbortSignal,
  ): Promise<Map<string, number[]>> {
    const result = new Map<string, number[]>();
    const uncached: BrainToolDefinition[] = [];

    // Check cache for each tool
    for (const tool of tools) {
      const hash = hashDescription(tool.rich_description);
      const cached = this.cache.entries[tool.id];

      if (cached && cached.hash === hash) {
        result.set(tool.id, cached.embedding);
      } else {
        uncached.push(tool);
      }
    }

    // Encode uncached tools in a single batch call
    if (uncached.length > 0) {
      const descriptions = uncached.map((t) => t.rich_description);
      const response = await client.encodeActions(descriptions, signal);

      for (let i = 0; i < uncached.length; i++) {
        const tool = uncached[i];
        const embedding = response.embeddings[i].embedding;
        const hash = hashDescription(tool.rich_description);

        result.set(tool.id, embedding);

        // Update cache
        this.cache.entries[tool.id] = {
          toolId: tool.id,
          hash,
          embedding,
          dim: response.dim,
          cachedAt: new Date().toISOString(),
        };
      }

      this.saveToDisk();
    }

    return result;
  }

  /**
   * Invalidate cache entries for specific tool IDs.
   * Used when tools are hot-reloaded.
   */
  invalidate(toolIds: string[]): void {
    for (const id of toolIds) {
      delete this.cache.entries[id];
    }
    this.saveToDisk();
  }

  /** Clear entire cache. */
  clear(): void {
    this.cache = { version: 1, entries: {} };
    this.saveToDisk();
  }

  /** Number of cached entries. */
  get size(): number {
    return Object.keys(this.cache.entries).length;
  }

  // -----------------------------------------------------------------------
  // Disk I/O
  // -----------------------------------------------------------------------

  private loadFromDisk(): CacheFile {
    if (!existsSync(this.cachePath)) {
      return { version: 1, entries: {} };
    }
    try {
      const data = JSON.parse(readFileSync(this.cachePath, "utf-8")) as CacheFile;
      if (data.version !== 1) return { version: 1, entries: {} };
      return data;
    } catch {
      return { version: 1, entries: {} };
    }
  }

  private saveToDisk(): void {
    const dir = dirname(this.cachePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.cachePath, JSON.stringify(this.cache), "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashDescription(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
