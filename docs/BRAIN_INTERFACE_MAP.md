# Brain Interface Map — OpenClaw Agent Runtime

## Overview

This document maps the "Brain" boundary in the OpenClaw codebase — the exact interfaces,
types, and control flow that define the agent's reasoning/planning loop. This is the
surgery guide for replacing the LLM-as-planner ReAct loop with the Stratus world model.

---

## Architecture

```
runEmbeddedPiAgent(params)           ← Infrastructure (stays)
  │
  ├─ Resolve model (provider, modelId)
  ├─ Load session history from sessionFile
  ├─ Build system prompt + bootstrap context
  ├─ Create tool definitions
  ├─ Create AgentSession with SessionManager
  │
  └─ OUTER RETRY LOOP              ← Infrastructure (stays)
      │
      ├─ Select auth profile
      ├─ Resolve API key
      │
      └─ runEmbeddedAttempt()
          │
          ├─ Create subscription to session events
          ├─ Hook: before_prompt_build
          ├─ Call activeSession.prompt(effectivePrompt)
          │   │
          │   └─ INNER LOOP         ← BRAIN (replaced by Stratus)
          │       │
          │       ├─ streamFn(model, { messages }, signal)
          │       │  └─ LLM Provider API call
          │       │
          │       ├─ Parse streaming response
          │       ├─ Extract tool_use blocks
          │       ├─ Dispatch tools
          │       ├─ Collect tool results
          │       ├─ Append to session.messages
          │       │
          │       └─ Loop until stop_reason != "tool_calls"
          │
          └─ Return result
```

---

## Key Files

| File | Purpose | Brain Relevance |
|------|---------|----------------|
| `src/agents/pi-embedded-runner/run.ts` | Main retry loop, failover | Infrastructure — stays |
| `src/agents/pi-embedded-runner/run/attempt.ts` | Core agent loop | **Contains Brain boundary** |
| `src/agents/pi-embedded-subscribe.ts` | Streaming event model | Infrastructure — stays |
| `src/agents/pi-embedded-runner/model.ts` | Model discovery | Stays (LLM still used for generation) |
| `src/agents/pi-embedded-helpers.ts` | Prompt assembly helpers | Partially stays |
| `src/agents/pi-embedded-payloads.ts` | Response payload types | Infrastructure — stays |
| `src/plugins/runtime/runtime-embedded-pi.runtime.ts` | Plugin instantiation | Infrastructure — stays |

---

## The Brain Boundary

### What IS the Brain (gets replaced)

1. **LLM invocation via `streamFn`** — The call to `streamFn(model, { messages }, signal)`
   at line ~2330 in `attempt.ts`. This is where the LLM decides what to do.

2. **Tool call parsing** — Extracting `tool_use` blocks from the LLM streaming response.
   The session SDK does this internally.

3. **Decision loop** — The session SDK's inner loop that calls LLM → parses tool calls →
   executes tools → calls LLM again until `stop_reason === "end_turn"`.

4. **Stop condition** — The LLM deciding when it's "done" via `stop_reason`.

### What is NOT the Brain (stays as infrastructure)

1. **Outer retry loop** — Auth rotation, compaction, overflow, rate limit backoff
2. **Auth/API key management** — Profile selection, token refresh
3. **Session persistence** — SessionManager, message history, compaction
4. **Hook system** — before_compaction, after_compaction, agent_end, after_tool_call
5. **Tool definitions** — createOpenClawCodingTools() creates the tool registry
6. **Tool result formatting** — Media extraction, truncation, markdown formatting
7. **Streaming callbacks** — onPartialReply, onBlockReply, onToolResult
8. **Error classification** — Failover reason detection

---

## Critical Types

### Input: RunEmbeddedPiAgentParams (simplified)

```typescript
{
  sessionId: string;
  prompt: string;                    // User message
  images?: ImageContent[];           // Vision input
  provider: string;                  // "anthropic" | "openai" | etc.
  model: string;                     // "claude-opus-4.1" | etc.
  sessionFile: string;               // Conversation history path
  workspaceDir: string;              // Sandbox context
  thinkLevel?: ThinkLevel;           // "off" | "low" | "medium" | "high"
  extraSystemPrompt?: string;        // Plugin-provided additions
  skillsSnapshot?: SkillSnapshot;    // Available tools/skills
  disableTools?: boolean;            // LLM-only mode
  clientTools?: ClientToolDefinition[];
}
```

### Output: EmbeddedPiRunResult (simplified)

```typescript
{
  payloads?: Array<{
    text?: string;
    mediaUrl?: string;
    isError?: boolean;
    isReasoning?: boolean;
  }>;
  meta: {
    durationMs: number;
    stopReason?: string;             // "end_turn" | "tool_calls" | "error"
    agentMeta?: {
      provider: string;
      model: string;
      usage?: { input, output, total };
    };
    error?: {
      kind: string;
      message: string;
    };
  };
}
```

### Session Message Type

```typescript
type AgentMessage = {
  role: "user" | "assistant" | "system";
  content: string | AgentMessageContent[];
}

type AgentMessageContent =
  | { type: "text"; text: string }
  | { type: "image"; image: ImageContent }
  | { type: "toolCall"; toolCall: { id: string; name: string; arguments: string } }
  | { type: "toolResult"; toolResult: { id: string; content: string; isError?: boolean } }
```

### StreamFn (The Brain's Entry Point)

```typescript
type StreamFn = (
  model: Model<Api>,
  context: { messages: AgentMessage[] },
  options?: { signal?: AbortSignal }
) => AsyncIterable<StreamEvent>
```

This is the exact function signature that Stratus Brain must implement to plug into
the existing session SDK. The wrapper pipeline (auth check, sanitization, logging)
stays in place — only the core `streamFn` changes.

---

## Context Assembly Pipeline

1. **Bootstrap context**: Workspace files (`.openclaw` config) → injected into system prompt
2. **System prompt**: Base prompt + plugin hooks (`before_prompt_build`) + TTS hints
3. **Tool registration**: `createOpenClawCodingTools()` → bash, write_file, read_file, etc.
4. **Message history**: `SessionManager.open(sessionFile)` → loaded, limited by token budget
5. **Prompt injection**: `activeSession.prompt(effectivePrompt, { images })`

---

## StreamFn Provider Map

| Provider | Implementation | Notes |
|----------|---------------|-------|
| Anthropic | `streamSimple` (default) | Standard Messages API |
| Anthropic Vertex | `createAnthropicVertexStreamFnForModel()` | Google Cloud |
| OpenAI | `createOpenAIWebSocketStreamFn()` | WebSocket API |
| Ollama | `createConfiguredOllamaStreamFn()` | Local models |
| Google GenAI | `streamSimple` + schema sanitization | Gemini models |
| Default | `streamSimple` | Fallback |

**StreamFn wrapper pipeline** (applied in order):
1. Cache trace (debugging)
2. Auth check (validate/refresh API key)
3. Malformed tool call sanitization
4. Tool name trimming
5. Provider-specific fixes (xAI base64 decode)
6. Payload logging

---

## Hook Lifecycle

| Hook | When | What For |
|------|------|----------|
| `before_model_resolve` | Before model resolution | Override provider/model |
| `before_prompt_build` | Before prompt assembly | Inject context |
| `before_compaction` | Before session compaction | Cleanup |
| `after_compaction` | After compaction | Stats, memory sync |
| `after_tool_call` | After each tool executes | Logging, metrics |
| `agent_end` | After run completes | Analytics |

---

## Streaming Callbacks

```typescript
{
  onPartialReply?: (payload) => void,     // Streaming text chunks
  onAssistantMessageStart?: () => void,   // LLM started responding
  onBlockReply?: (payload) => void,       // Complete message block
  onReasoningStream?: (payload) => void,  // Extended thinking output
  onToolResult?: (payload) => void,       // Tool execution complete
  onAgentEvent?: (event) => void,         // Debug events
}
```

These fire during the session loop and are consumed by the subscription model
in `pi-embedded-subscribe.ts`. They STAY in place — Stratus Brain must emit
compatible events.

---

## Attachment Point for Stratus Brain

The cleanest integration point is **replacing `streamFn`** at the session creation
site in `attempt.ts` (~line 2330):

```typescript
// Current: LLM-based streamFn
const streamFn = streamSimple; // or provider-specific variant

// Stratus: Replace with world model planner
const streamFn = createStratusStreamFn({
  stratusClient,    // RPC to sidecar
  tools,            // Available tool embeddings
  goal,             // Extracted from user prompt
  probeConfig,      // Which probe to use
});
```

The Stratus `streamFn` must:
1. Accept `(model, { messages }, options)` — same signature
2. Yield `AsyncIterable<StreamEvent>` — same event format
3. Include `tool_use` blocks in output — same tool dispatch
4. Emit `stop_reason` when planning complete

This approach keeps the session SDK's tool execution loop intact.
The Brain only changes HOW decisions are made, not how tools are dispatched.

---

## Dependencies on External Packages

| Package | Used For | Stays/Changes |
|---------|----------|---------------|
| `@mariozechner/pi-ai` | Model definitions, `streamSimple` | Stays (LLM generation) |
| `@mariozechner/pi-agent-core` | `AgentSession`, `StreamFn`, message types | Stays (session management) |
| `@mariozechner/pi-coding-agent` | `SessionManager`, `createAgentSession` | Stays (persistence) |

The Stratus Brain does NOT replace these packages. It plugs in via the `StreamFn`
interface they define.
