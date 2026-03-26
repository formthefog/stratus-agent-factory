/**
 * Goal Extractor — Extracts user intent from conversation for goal embedding
 *
 * Simple cases: single-turn request → goal is the request text.
 * Complex cases: multi-turn conversation → synthesizes intent.
 * Falls back to LLM extraction when goal is ambiguous.
 *
 * The extracted goal text gets encoded via /encode_goal on the sidecar
 * to produce the goal embedding used for probe ranking and proximity checks.
 *
 * @purpose Extract goal from user message/conversation for Stratus planning
 * @spec AGENT_FACTORY_SPEC.md#b22-build-goal-extractor
 */

import type { StratusClient } from "./StratusClient.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationTurn {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
}

export interface ExtractedGoal {
  /** The goal text used for embedding */
  text: string;
  /** Confidence in the extraction (0-1) */
  confidence: number;
  /** Whether LLM was used for extraction */
  usedLlm: boolean;
  /** Cached goal embedding (set after first encode) */
  embedding?: number[];
}

/**
 * Optional LLM function for complex goal extraction.
 * The caller provides this — we don't import any specific LLM SDK.
 */
export type GoalLlmFn = (prompt: string) => Promise<string>;

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

export class GoalExtractor {
  private cachedGoal: ExtractedGoal | null = null;
  private llmFn: GoalLlmFn | null;

  constructor(llmFn?: GoalLlmFn) {
    this.llmFn = llmFn ?? null;
  }

  /**
   * Extract goal from conversation history.
   * Caches the result — call reset() when goal changes.
   */
  async extract(turns: ConversationTurn[]): Promise<ExtractedGoal> {
    if (this.cachedGoal) return this.cachedGoal;

    const userTurns = turns.filter((t) => t.role === "user");
    if (userTurns.length === 0) {
      return { text: "", confidence: 0, usedLlm: false };
    }

    // Single turn: goal is the message itself
    if (userTurns.length === 1) {
      this.cachedGoal = {
        text: userTurns[0].content,
        confidence: 0.9,
        usedLlm: false,
      };
      return this.cachedGoal;
    }

    // Multi-turn: try heuristic first, fall back to LLM
    const heuristic = this.heuristicExtract(userTurns);
    if (heuristic.confidence >= 0.7) {
      this.cachedGoal = heuristic;
      return this.cachedGoal;
    }

    // LLM extraction for ambiguous cases
    if (this.llmFn) {
      const llmGoal = await this.llmExtract(turns);
      this.cachedGoal = llmGoal;
      return this.cachedGoal;
    }

    // No LLM available, use heuristic result
    this.cachedGoal = heuristic;
    return this.cachedGoal;
  }

  /**
   * Encode the goal text into an embedding via the sidecar.
   * Caches the embedding on the ExtractedGoal.
   */
  async encode(
    goal: ExtractedGoal,
    client: StratusClient,
    signal?: AbortSignal,
  ): Promise<number[]> {
    if (goal.embedding) return goal.embedding;

    const response = await client.encodeGoal(goal.text, signal);
    goal.embedding = response.embedding;
    return response.embedding;
  }

  /** Reset cached goal (e.g., when user sends a new message). */
  reset(): void {
    this.cachedGoal = null;
  }

  /** Get the cached goal without re-extracting. */
  getCached(): ExtractedGoal | null {
    return this.cachedGoal;
  }

  // -----------------------------------------------------------------------
  // Heuristic Extraction
  // -----------------------------------------------------------------------

  /**
   * Heuristic: use the most recent user message, but weight it by
   * whether it looks like a new request or a follow-up.
   */
  private heuristicExtract(userTurns: ConversationTurn[]): ExtractedGoal {
    const latest = userTurns[userTurns.length - 1].content;

    // If latest message is a clear new request (starts with imperative verb, question)
    if (this.isNewRequest(latest)) {
      return { text: latest, confidence: 0.85, usedLlm: false };
    }

    // If latest is short (likely a follow-up like "yes", "do it", "try that")
    if (latest.length < 30) {
      // Combine with previous user message for context
      const prev = userTurns[userTurns.length - 2]?.content;
      if (prev) {
        return {
          text: `${prev} → ${latest}`,
          confidence: 0.6,
          usedLlm: false,
        };
      }
    }

    return { text: latest, confidence: 0.5, usedLlm: false };
  }

  private isNewRequest(text: string): boolean {
    const lower = text.toLowerCase().trim();
    // Starts with imperative verb
    if (/^(create|build|fix|find|search|update|delete|show|list|run|deploy|test|check|write|read|send)\b/.test(lower)) {
      return true;
    }
    // Is a question
    if (/^(what|how|why|when|where|who|can|could|would|should|is|are|do|does)\b/.test(lower)) {
      return true;
    }
    // Contains "please" or "I want/need"
    if (/please|i want|i need|i'd like/.test(lower)) {
      return true;
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // LLM Extraction
  // -----------------------------------------------------------------------

  private async llmExtract(turns: ConversationTurn[]): Promise<ExtractedGoal> {
    if (!this.llmFn) {
      return { text: "", confidence: 0, usedLlm: false };
    }

    const context = turns
      .slice(-6) // Last 6 turns max
      .map((t) => `${t.role}: ${t.content}`)
      .join("\n");

    const prompt = [
      "Extract the user's current goal from this conversation.",
      "Return ONLY the goal as a single sentence. No explanation.",
      "",
      context,
    ].join("\n");

    const goalText = await this.llmFn(prompt);
    return {
      text: goalText.trim(),
      confidence: 0.8,
      usedLlm: true,
    };
  }
}
