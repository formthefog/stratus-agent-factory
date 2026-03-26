/**
 * State Encoder Bridge — Assembled state text to embedding vector
 *
 * Takes the canonical state text from StateAssembler and encodes it
 * via the sidecar's /encode_state endpoint. Handles the split between
 * static context (cached) and dynamic state (re-encoded each step).
 *
 * The V6 JEPA model uses a dual-stream architecture:
 * - Context stream: static parts (goal, user, tools) — cached
 * - Transition stream: dynamic parts (status, progress) — fresh each step
 *
 * This bridge manages that split, caching the context encoding and only
 * re-encoding the dynamic portion on each step.
 *
 * @purpose Bridge between assembled state text and sidecar state encoding
 * @spec AGENT_FACTORY_SPEC.md#b24-build-state-encoder-bridge
 */

import type { StratusClient } from "./StratusClient.js";
import type { StateAssembler, StateAssemblyInput } from "./StateAssembler.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EncodedState {
  /** Full state embedding (fused context + dynamic) */
  embedding: number[];
  /** Static context embedding (for caching) */
  contextEmbedding: number[];
  /** Dynamic state embedding (changes each step) */
  dynamicEmbedding: number[];
  /** Encoding latency in ms */
  encodingMs: number;
  /** Whether context was served from cache */
  contextCached: boolean;
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

export class StateEncoderBridge {
  private assembler: StateAssembler;
  private client: StratusClient;

  /** Cached static context embedding */
  private cachedContextText: string | null = null;
  private cachedContextEmbedding: number[] | null = null;

  constructor(assembler: StateAssembler, client: StratusClient) {
    this.assembler = assembler;
    this.client = client;
  }

  /**
   * Encode the full state: assemble text, encode via sidecar,
   * return the combined embedding.
   *
   * Caches the static context portion — only re-encodes if it changes.
   */
  async encode(
    input: StateAssemblyInput,
    signal?: AbortSignal,
  ): Promise<EncodedState> {
    const start = Date.now();

    // Assemble static and dynamic portions separately
    const staticText = this.assembler.assembleStatic(input);
    const dynamicText = this.assembler.assembleDynamic(input);

    // Check if static context changed
    let contextEmbedding: number[];
    let contextCached = false;

    if (this.cachedContextText === staticText && this.cachedContextEmbedding) {
      contextEmbedding = this.cachedContextEmbedding;
      contextCached = true;
    } else {
      const contextResponse = await this.client.encodeState(staticText, signal);
      contextEmbedding = contextResponse.embedding;
      this.cachedContextText = staticText;
      this.cachedContextEmbedding = contextEmbedding;
    }

    // Always encode dynamic state fresh
    const dynamicResponse = await this.client.encodeState(dynamicText, signal);
    const dynamicEmbedding = dynamicResponse.embedding;

    // Fuse context + dynamic embeddings
    // Simple weighted average: context provides grounding, dynamic provides recency
    const embedding = fuseEmbeddings(contextEmbedding, dynamicEmbedding, 0.6, 0.4);

    return {
      embedding,
      contextEmbedding,
      dynamicEmbedding,
      encodingMs: Date.now() - start,
      contextCached,
    };
  }

  /**
   * Encode just the full assembled state as a single block.
   * Simpler path — no context/dynamic split. Used for one-shot encoding.
   */
  async encodeFull(
    input: StateAssemblyInput,
    signal?: AbortSignal,
  ): Promise<{ embedding: number[]; encodingMs: number }> {
    const text = this.assembler.assemble(input);
    const start = Date.now();
    const response = await this.client.encodeState(text, signal);
    return {
      embedding: response.embedding,
      encodingMs: Date.now() - start,
    };
  }

  /** Invalidate the cached context (e.g., when tools change). */
  invalidateCache(): void {
    this.cachedContextText = null;
    this.cachedContextEmbedding = null;
  }
}

// ---------------------------------------------------------------------------
// Embedding Fusion
// ---------------------------------------------------------------------------

/**
 * Fuse two embedding vectors with weighted average, then L2-normalize.
 * This is the simplest fusion strategy; the V6 model's FiLM conditioning
 * handles the real fusion at inference time.
 */
function fuseEmbeddings(
  a: number[],
  b: number[],
  weightA: number,
  weightB: number,
): number[] {
  const dim = Math.min(a.length, b.length);
  const fused = new Array<number>(dim);

  for (let i = 0; i < dim; i++) {
    fused[i] = a[i] * weightA + b[i] * weightB;
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    norm += fused[i] * fused[i];
  }
  norm = Math.sqrt(norm);

  if (norm > 0) {
    for (let i = 0; i < dim; i++) {
      fused[i] /= norm;
    }
  }

  return fused;
}
