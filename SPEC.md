# Stratus Agent Factory — Technical Specification

## Vision

An AI-powered agent factory that churns out domain-specific agents at scale.
Each agent is powered by the Stratus X1 world model for planning and action
selection, a user-selected LLM for generation, and a battle-tested harness
(OpenClaw fork) for execution. The first agent built is the Agent Builder
Agent — the factory that builds all future agents.

**The thesis:** OpenClaw is amazing hands for a brain that doesn't yet exist.
Stratus IS that brain. By replacing the LLM-as-planner ReAct loop with a
world model that actually understands state transitions, we build agents that
plan instead of guess, verify instead of hope, and recover instead of retry.

---

## Language Strategy: v1 (TypeScript) → v2 (Python-native)

### The Tradeoff

| | v1: OpenClaw Fork (TypeScript) | v2: Python-native Rewrite |
|--|-------------------------------|--------------------------|
| **Language** | TypeScript (OpenClaw codebase) | Python |
| **Stratus integration** | HTTP sidecar (TS↔Python bridge) | In-process, zero bridge |
| **Time to ship** | 4-6 weeks | 3-4 months |
| **Bridge overhead** | ~5-10ms per Stratus call | 0ms |
| **Ecosystem** | 5,700+ OpenClaw skills, 50+ channels | Must rebuild or wrap |
| **Memory footprint** | Node.js + Python sidecar (~800MB) | Single Python process (~400MB) |
| **Codebase size** | ~50k LOC (inherited) + ~5k new | ~15k LOC (purpose-built) |

### Why v1 First (Ship Fast)

OpenClaw gives us battle-tested infrastructure for free: channels (Slack, Discord, WhatsApp, etc.),
skill marketplace, scheduling, memory, WebSocket gateway. Building these from scratch is months
of work that adds zero differentiation. The sidecar bridge tax (~5-10ms per call) is negligible
compared to tool execution latency (~100-5000ms).

**v1 proves the thesis:** Stratus Brain + any harness = better agents. The harness choice is
secondary to proving the brain works.

### Why v2 Eventually (Clean Architecture)

Once Stratus Brain is validated in production:
- **Zero bridge overhead** — Stratus runs in-process, no serialization/HTTP round-trips
- **Single runtime** — One Python process, simpler deployment, lower memory
- **Native Stratus types** — No TypeScript↔Python type mapping, direct tensor access
- **Cleaner codebase** — Purpose-built for world model agents, not adapted from LLM agent framework
- **Python ecosystem** — Direct access to PyTorch, HuggingFace, scientific computing stack

### Design Constraints for Clean Migration

**These constraints apply to ALL v1 code. They ensure v2 migration is a rewrite, not an untangling.**

1. **IBrain interface is the ONLY contract between harness and brain.** No harness code may
   import from `src/brain/stratus/` internals. All communication goes through `IBrain.processTurn()`,
   `IBrain.getState()`, `IBrain.reset()`, `IBrain.configure()`.

2. **StratusClient (RPC) is the ONLY Stratus touchpoint.** The TypeScript brain calls Stratus
   exclusively through `StratusClient`. No direct HTTP calls to the sidecar from anywhere else.
   In v2, `StratusClient` becomes direct Python function calls — one file to rewrite.

3. **Tool Registry is serializable.** `ToolRegistryEntry` must be JSON-serializable. No runtime
   objects, no closures, no TypeScript-specific types. In v2, the same JSON feeds the Python tool
   registry directly.

4. **Agent Package format is language-agnostic.** Agent configs, tool definitions, probe configs,
   and test scenarios are all YAML/JSON. No TypeScript in the package format. v2 loads the same
   packages without conversion.

5. **Sidecar RPC protocol is the v2 internal API.** The HTTP endpoints (`/encode_state`,
   `/probe_rank`, `/tree_search`, etc.) map 1:1 to Python functions. In v2, these become
   direct function calls with the same signatures.

6. **Tests are behavior tests, not implementation tests.** Test against IBrain interface and
   agent outcomes, not internal StratusBrain methods. v2 must pass the same test suite
   (rewritten in pytest but same assertions).

7. **No TypeScript-specific patterns in core logic.** Avoid decorators, complex generics,
   or TS-specific metaprogramming in brain/tool/agent code. Keep logic procedural and
   translatable.

### v2 Migration Scope

When v2 begins, the migration is:

| Component | v1 → v2 |
|-----------|---------|
| Gateway | OpenClaw TypeScript → Python (FastAPI/WebSocket) or wrap existing |
| Brain | `StratusBrain.ts` → `stratus_brain.py` (direct Stratus calls) |
| Sidecar | Eliminated — Stratus runs in-process |
| Tool Registry | Same JSON format, Python loader |
| Agent Packages | Unchanged — YAML/JSON, language-agnostic |
| Skills/Tools | TypeScript tool executors → Python tool executors |
| Memory | SQLite + markdown (same), Python interface |
| CLI | TypeScript CLI → Python CLI (click/typer) |
| Tests | Vitest → pytest (same behavioral assertions) |

**The brain migrates trivially** (StratusClient calls become function calls). **The harness is
the real work** — but by then we'll know exactly what we need, because v1 taught us.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Workstream A: OpenClaw Fork — Stratus Harness](#2-workstream-a-openclaw-fork--stratus-harness)
3. [Workstream B: Stratus Brain Component](#3-workstream-b-stratus-brain-component)
4. [Workstream C: Agent Builder Agent](#4-workstream-c-agent-builder-agent)
5. [Workstream D: Agent Runtime & Deployment](#5-workstream-d-agent-runtime--deployment)
6. [Workstream E: Probe Training Pipeline](#6-workstream-e-probe-training-pipeline)
7. [Workstream F: SDK & Developer Experience](#7-workstream-f-sdk--developer-experience)
8. [Workstream G: Testing & Validation](#8-workstream-g-testing--validation)
9. [Workstream H: First Vertical Agents](#9-workstream-h-first-vertical-agents)
10. [Dependencies & Parallelization Map](#10-dependencies--parallelization-map)
11. [Metrics & Success Criteria](#11-metrics--success-criteria)
12. [Decision Log](#12-decision-log)

---

## 1. Architecture Overview

### 1.1 System Diagram

```
                    Channels
                (Slack, WhatsApp, Discord, CLI, Web, API)
                        |
                        v
              +-------------------+
              |     Gateway       |  (OpenClaw - unchanged)
              |  WebSocket Hub    |
              +-------------------+
                        |
                        v
              +-------------------+
              |   Stratus Brain   |  (NEW - replaces ReAct Brain)
              |                   |
              |  State Encoder    |  state text → 1024-d embedding
              |  Action Encoder   |  tool descs → 1024-d embeddings
              |  Policy Probes    |  (state, goal) → ranked actions
              |  World Model      |  (state, action) → predicted next state
              |  Tree Search      |  multi-step lookahead when ambiguous
              |  Goal Monitor     |  cosine(state, goal) → termination
              +-------------------+
                   |          |
          action   |          | generation needed?
          selected |          |
                   v          v
         +-----------+  +-----------+
         |   Tool    |  |    LLM    |  (user-selected: Claude, GPT, Llama, etc.)
         | Executor  |  | Generator |  (called ONLY for content generation)
         +-----------+  +-----------+
                   |          |
                   v          v
              +-------------------+
              | Observation       |  (NEW - encodes tool output → state embedding)
              | Encoder           |
              +-------------------+
                        |
                        v
              +-------------------+
              |     Memory        |  (OpenClaw - enhanced)
              |  Markdown + SQLite|
              |  + State History  |  (NEW - embedding trajectory log)
              +-------------------+
```

### 1.2 Control Loop Comparison

```
CURRENT OPENCLAW (ReAct):
  while not done:
    prompt = assemble_context(history, memory, tools)
    response = LLM(prompt)                          # LLM decides everything
    if response.has_tool_call:
      result = execute(response.tool_call)
      history.append(result)
    else:
      return response.text                          # LLM decides when done

STRATUS BRAIN:
  state_emb = encode_state(initial_context)
  goal_emb = encode_goal(user_request)
  tool_embs = encode_tools(available_skills)

  while goal_proximity(state_emb, goal_emb) < threshold:
    # 1. Probe ranks actions (2ms)
    candidates = probe.rank(state_emb, goal_emb, tool_embs)

    # 2. Tree search if ambiguous (50-250ms)
    if candidates[0].score - candidates[1].score < 0.2:
      best_action = tree_search(state_emb, goal_emb, candidates, depth=3)
    else:
      best_action = candidates[0]

    # 3. If action needs generated content, call LLM
    if best_action.requires_generation:
      params = LLM.generate(best_action.param_template, context)
      best_action.fill_params(params)

    # 4. Execute
    result = execute(best_action)

    # 5. Encode observation → new state
    state_emb = observation_encoder(result, state_emb)

    # 6. Check for failure / backtrack
    if recovery_probe.detects_failure(state_emb):
      state_emb = backtrack(state_history)

  return summarize(state_history)  # LLM generates final summary
```

### 1.3 Component Ownership

| Component | Source | Modification |
|-----------|--------|-------------|
| Gateway | OpenClaw | Unchanged — channels, WebSocket, routing |
| Brain | **New** | Stratus Brain replaces ReAct Brain entirely |
| Memory | OpenClaw | Enhanced with state embedding trajectory |
| Skills | OpenClaw | Skills become tool registry entries + embeddings |
| Heartbeat | OpenClaw | Unchanged — scheduling, monitoring |
| Observation Encoder | **New** | Encodes tool outputs → state embeddings |
| Probe System | Stratus | Existing probe infrastructure (ProbeRouter, ProbeRegistry) |
| Tree Search | **New** | Beam search over world model rollouts |
| Agent Builder | **New** | Meta-agent that constructs other agents |

---

## 2. Workstream A: OpenClaw Fork — Stratus Harness

**Goal:** Fork OpenClaw, strip the ReAct Brain, prepare the harness for
Stratus Brain injection. Keep everything else intact.

### A.1 Fork & Repository Setup

#### A.1.1 Create fork repository
- Fork `openclaw/openclaw` to `formation-ai/stratus-claw`
- Set up branch protection on `main`
- Configure CI (GitHub Actions — port from OpenClaw's existing CI)
- Add Formation team as maintainers
- **Output:** Clean fork with CI passing

#### A.1.2 Dependency audit
- Catalog all OpenClaw dependencies (package.json)
- Identify which are needed for Gateway/Memory/Skills/Heartbeat
- Identify which are Brain-only (can be removed or replaced)
- Document LLM provider dependencies (which stay for generation)
- **Output:** Dependency map document

#### A.1.3 License compliance review
- OpenClaw is MIT-licensed — verify fork rights
- Ensure any new code maintains compatible licensing
- Document attribution requirements
- **Output:** License compliance checklist

### A.2 Brain Extraction Surgery

#### A.2.1 Map the Brain boundary
- Read `src/agents/piembeddedrunner.ts` line by line
- Document every import, interface, and type the Brain exposes
- Document every callback/hook point other components use to talk to Brain
- Map the exact function signatures for:
  - `contextAssembly()` — what goes in, what comes out
  - `modelInvocation()` — the LLM call interface
  - `toolExecution()` — how tool calls are dispatched
  - `sessionPersistence()` — how turn results are saved
- **Output:** `docs/BRAIN_INTERFACE_MAP.md`

#### A.2.2 Define the Brain interface contract
- Create `src/brain/IBrain.ts` — TypeScript interface
- Must support:
  - `processTurn(session, message) → BrainResponse`
  - `getState(session) → BrainState`
  - `reset(session) → void`
  - `configure(config: BrainConfig) → void`
- BrainResponse must include:
  - `actions_taken: ActionRecord[]`
  - `generation_calls: GenerationRecord[]` (LLM calls made)
  - `final_response: string`
  - `state_trajectory: StateSnapshot[]`
  - `goal_proximity: number`
  - `steps_taken: number`
- **Output:** `src/brain/IBrain.ts` with full type definitions
- **v2 migration note:** This interface becomes a Python ABC. Same method signatures,
  same response types (as dataclasses). Design the interface to be language-agnostic —
  no TypeScript-specific types in the contract.

#### A.2.3 Create Brain adapter for existing ReAct
- Wrap OpenClaw's existing ReAct Brain behind `IBrain` interface
- This ensures the fork works identically to upstream while we build Stratus Brain
- All existing tests must pass with the adapter
- **Output:** `src/brain/ReActBrainAdapter.ts`

#### A.2.4 Create Brain registry
- `src/brain/BrainRegistry.ts`
- Allows selecting brain implementation via config:
  ```json
  { "brain": "stratus" }   // or "react" for legacy
  ```
- Falls back to ReAct if Stratus not configured
- **Output:** `src/brain/BrainRegistry.ts`

#### A.2.5 Wire Brain registry into agent runtime
- Modify `piembeddedrunner.ts` to use `BrainRegistry.get()` instead of
  hardcoded ReAct loop
- Verify all existing tests still pass
- **Output:** Modified `piembeddedrunner.ts`

### A.3 Skill-to-Tool Registry Bridge

#### A.3.1 Analyze OpenClaw skill manifest format
- Read skill.md YAML frontmatter spec
- Document: name, version, description, triggers, permissions, parameters
- Catalog 20 representative skills from ClawHub marketplace
- **Output:** `docs/SKILL_FORMAT_ANALYSIS.md`

#### A.3.2 Design tool registry schema
- Each skill becomes a tool registry entry with:
  ```typescript
  interface ToolRegistryEntry {
    id: string;                    // skill name
    name: string;                  // human readable
    description: string;           // natural language
    rich_description: string;      // training-format: "action_type (domain). description. effects: ..."
    parameters: ParameterSchema;   // JSON schema for params
    requires_generation: boolean;  // does this need LLM for params?
    generation_template?: string;  // prompt template if yes
    domain: string;                // vertical/category
    effects: string[];             // what this tool changes
    preconditions: string[];       // when this tool is valid
    embedding?: Float32Array;      // cached action embedding (1024-d)
  }
  ```
- **Output:** `src/tools/ToolRegistryEntry.ts`
- **v2 migration constraint:** This schema MUST be JSON-serializable. Use plain types
  only (string, number, boolean, arrays, objects). The `embedding` field is stored as
  `number[]` in JSON, loaded as `Float32Array` at runtime. In v2, the same JSON schema
  feeds a Python `@dataclass` with identical field names.

#### A.3.3 Build skill-to-tool converter
- Reads OpenClaw skill manifests
- Extracts/infers: description, effects, preconditions, domain
- Generates `rich_description` matching Stratus training format:
  `"{action_type} ({domain}). {description}. effects: {effects}"`
- For complex skills with multiple capabilities, split into multiple tool entries
- **Output:** `src/tools/SkillToToolConverter.ts`

#### A.3.4 Build tool embedding cache
- On agent startup, encode all tool `rich_description` via ActionEncoder
- Cache embeddings to disk (`.stratus/tool_embeddings.bin`)
- Invalidate on skill manifest change (hash-based)
- Support hot-reload when new skills are added
- **Output:** `src/tools/ToolEmbeddingCache.ts`

#### A.3.5 Build tool registry manager
- Loads tool entries from:
  1. OpenClaw skills directory (`~/.openclaw/skills/`)
  2. Agent-specific tool definitions (`agent.tools.yaml`)
  3. Runtime-registered tools (via API)
- Provides: `getAll()`, `getByDomain()`, `getEmbeddings()`, `search(query)`
- **Output:** `src/tools/ToolRegistry.ts`

### A.4 Memory Enhancement

#### A.4.1 Design state trajectory store
- Append-only log of state embeddings per session:
  ```typescript
  interface StateSnapshot {
    step: number;
    timestamp: string;
    state_embedding: Float32Array;  // 1024-d
    action_taken: string;
    goal_proximity: number;
    probe_confidence: number;
  }
  ```
- Storage: binary file per session (`.stratus/trajectories/<session_id>.bin`)
- **Output:** `src/memory/StateTrajectoryStore.ts`

#### A.4.2 Integrate state trajectory with OpenClaw memory
- On session end, generate text summary from trajectory:
  - Steps taken, goal proximity curve, key decision points
  - Actions that improved/degraded goal proximity
- Write to OpenClaw's daily memory markdown file
- This lets OpenClaw's existing memory search find trajectory insights
- **Output:** `src/memory/TrajectoryMemoryBridge.ts`

#### A.4.3 Implement trajectory replay
- Load a past session's trajectory
- Replay through world model to analyze alternative paths
- Used by: Agent Builder Agent (to debug agent behavior)
- Used by: trace analyzer (retroactive analysis)
- **Output:** `src/memory/TrajectoryReplay.ts`

### A.5 Configuration System

#### A.5.1 Design Stratus agent config format
- Extension of OpenClaw's `openclaw.json`:
  ```json5
  {
    // OpenClaw standard config
    "name": "my-devops-agent",
    "channels": { ... },
    "memory": { ... },

    // Stratus extensions
    "brain": "stratus",
    "stratus": {
      "model_path": "~/.stratus/models/v6-latest.pt",
      "probe": "devops-incident-v1",       // or "general"
      "custom_probe_path": null,            // path to custom probe weights
      "llm_provider": "anthropic",          // for generation calls
      "llm_model": "claude-sonnet-4-5-20250514",
      "tree_search": {
        "enabled": true,
        "max_depth": 3,
        "beam_width": 5,
        "ambiguity_threshold": 0.2         // search when top-2 gap < this
      },
      "goal_proximity_threshold": 0.85,    // stop when goal is this close
      "max_steps": 20,                      // hard limit
      "observation_encoder": "adapter",     // "adapter" | "llm_bridge" | "direct"
      "tool_embedding_cache": true
    }
  }
  ```
- **Output:** `src/config/StratusConfig.ts` with validation

#### A.5.2 Build config validator
- Validates Stratus config on startup
- Checks model file exists, probe is valid, LLM provider configured
- Clear error messages for misconfiguration
- **Output:** `src/config/ConfigValidator.ts`

#### A.5.3 Build config migration tool
- Converts vanilla OpenClaw config → Stratus-enhanced config
- Preserves all existing OpenClaw settings
- Adds sensible Stratus defaults
- **Output:** `src/config/ConfigMigrator.ts`

---

## 3. Workstream B: Stratus Brain Component

**Goal:** Build the core Stratus Brain that replaces the ReAct loop. This is
the heart of the system — where the world model makes decisions.

### B.1 Stratus Runtime (TypeScript ↔ Python Bridge)

The world model is PyTorch (Python). OpenClaw is TypeScript/Node.js.
We need a bridge.

#### B.1.1 Evaluate bridge options
- **Option A:** HTTP microservice — Stratus API runs as sidecar, Brain calls via HTTP
  - Pro: Clean separation, already have Stratus API (`api/server.py`)
  - Con: Network latency per call (~5-10ms overhead)
- **Option B:** Python subprocess with IPC — spawn Python process, communicate via pipes/sockets
  - Pro: No network overhead, direct memory sharing possible
  - Con: Process management complexity
- **Option C:** ONNX Runtime in Node.js — export model to ONNX, run natively in JS
  - Pro: Zero bridge overhead, single process
  - Con: ONNX export complexity, potential accuracy loss, FiLM conditioning support unclear
- **Option D:** gRPC — typed RPC with protobuf, streaming support
  - Pro: Typed, efficient, streaming for tree search results
  - Con: Setup overhead
- **Recommendation:** Option A (HTTP sidecar) for v1, with clear interface that allows
  migration to Option C (ONNX) for production performance
- **Output:** Decision document with benchmarks

#### B.1.2 Define Stratus Brain RPC interface
- Whether HTTP or gRPC, the interface is the same:
  ```
  POST /encode_state    { text: string } → { embedding: float[1024] }
  POST /encode_goal     { text: string } → { embedding: float[1024] }
  POST /encode_actions  { descriptions: string[] } → { embeddings: float[N][1024] }
  POST /probe_rank      { state: float[1024], goal: float[1024], tools: float[N][1024], probe?: string } → { rankings: {tool_id, score}[] }
  POST /predict         { state: float[1024], action: float[1024] } → { next_state: float[1024] }
  POST /tree_search     { state: float[1024], goal: float[1024], tools: float[N][1024], depth: int, width: int } → { best_path: {action, predicted_state, score}[] }
  POST /goal_proximity  { state: float[1024], goal: float[1024] } → { proximity: float }
  POST /detect_failure  { state: float[1024], trajectory: float[][1024] } → { is_failure: bool, recovery_suggestions: string[] }
  ```
- **Output:** `src/brain/stratus/StratusRPC.ts` (client) + `stratus_sidecar/rpc.py` (server)

#### B.1.3 Build Stratus sidecar service
- Lightweight FastAPI/Flask server wrapping existing StratusBrain class
- Loads model once on startup, serves RPC calls
- Health check endpoint
- Model hot-reload endpoint (swap checkpoint without restart)
- Batch endpoint for parallel encoding (multiple states/actions at once)
- **Output:** `stratus_sidecar/server.py`

#### B.1.4 Build Stratus RPC client (TypeScript)
- TypeScript client matching RPC interface
- Connection pooling, retry logic, timeout handling
- Embedding caching (tool embeddings don't change within session)
- Batch support (encode multiple items in one call)
- **Output:** `src/brain/stratus/StratusClient.ts`
- **v2 migration note:** This is the single file that bridges TS↔Python. In v2, each
  method becomes a direct Python function call with identical signatures. Design methods
  as thin wrappers: `encodeState(text) → embedding`, `probeRank(state, goal, tools) → ranked`,
  etc. No business logic in the client — it's pure RPC.

#### B.1.5 Build sidecar lifecycle manager
- Auto-start sidecar when Stratus Brain initializes
- Health monitoring (restart if unresponsive)
- Graceful shutdown on agent stop
- GPU allocation (if available) vs CPU fallback
- **Output:** `src/brain/stratus/SidecarManager.ts`

### B.2 State Management

#### B.2.1 Design state assembly pipeline
- Converts OpenClaw's text context into Stratus state representation
- Inputs available:
  - Session history (conversation turns)
  - Memory files (preferences, learnings, contacts)
  - Current tool outputs
  - Channel metadata (who, where, when)
- Assembly into canonical format:
  ```
  ═══ GOAL HIERARCHY ═══
  [PRIMARY GOAL] {extracted from user message}

  ═══ USER CONTEXT ═══
  [USER] {from memory/preferences.md}
  [DOMAIN] {inferred from tools + conversation}

  ═══ AVAILABLE ACTIONS ═══
  {from tool registry}

  ═══ SYSTEM STATUS ═══
  [KNOWLEDGE]
  {accumulated from session}
  [LAST_ACTION]
  {last tool call → result}
  [CHANGED]
  {what changed since last step}

  ═══ PROGRESS ═══
  Step {N} | {proximity}% toward goal
  ```
- **Output:** `src/brain/stratus/StateAssembler.ts`

#### B.2.2 Build goal extractor
- Extracts goal from user message/conversation
- Simple cases: single-turn request → goal is the request
- Complex cases: multi-turn conversation → goal is the synthesized intent
- Uses LLM for extraction when goal is ambiguous (generation call, not planning)
- Caches goal embedding for the session
- **Output:** `src/brain/stratus/GoalExtractor.ts`

#### B.2.3 Build dynamic state tracker
- Tracks what has changed since last step
- Maintains KNOWLEDGE accumulation (step-by-step summary)
- Computes CHANGED diff between steps
- Updates PROGRESS section
- **Output:** `src/brain/stratus/DynamicStateTracker.ts`

#### B.2.4 Build state encoder bridge
- Takes assembled state text → calls Stratus sidecar → returns embedding
- Handles the dual-stream encoding:
  - Full state → Context Encoder (grounding)
  - Dynamic state → Transition Encoder (change detection)
  - Stream Fusion → final embedding
- Caches context encoding (static parts don't change often)
- **Output:** `src/brain/stratus/StateEncoderBridge.ts`

### B.3 Action Selection Pipeline

#### B.3.1 Build probe-based action ranker
- Takes (state_emb, goal_emb, tool_embs) → ranked actions
- Calls Stratus sidecar `/probe_rank`
- Returns top-K candidates with scores
- Supports probe selection:
  - General probes: planning-v2, tool-use-v2, recovery-v2, coordination-v2
  - Custom probes: per-agent domain-specific probe
  - ProbeRouter cascade: try custom → fall back to general
- **Output:** `src/brain/stratus/ActionRanker.ts`

#### B.3.2 Build tree search orchestrator
- When top-2 candidates are within `ambiguity_threshold`:
  1. For each candidate in top-K:
     - Predict next state via world model
     - Rank next actions from predicted state
     - Recurse to depth D
  2. Score each path by cumulative goal proximity
  3. Return best path's first action
- Configurable: depth, beam width, pruning threshold
- Timing budget: abort if wall time exceeds limit (default 500ms)
- **Output:** `src/brain/stratus/TreeSearch.ts`

#### B.3.3 Build generation router
- After action is selected, determine if LLM generation is needed
- Check `tool_registry_entry.requires_generation`
- If yes:
  - Build generation prompt from action template + context
  - Call LLM provider (Claude, GPT, etc.)
  - Fill action parameters with generated content
- If no:
  - Action is fully specified by Stratus (e.g., API calls with known params)
- **Output:** `src/brain/stratus/GenerationRouter.ts`

#### B.3.4 Build action executor bridge
- Takes selected + parameterized action → OpenClaw tool execution
- Maps Stratus action back to OpenClaw skill invocation
- Handles: success, error, timeout, partial results
- Captures tool output for observation encoding
- **Output:** `src/brain/stratus/ActionExecutor.ts`

### B.4 Observation & Loop Control

#### B.4.1 Build observation encoder (v1 — LLM bridge)
- Before we have a trained Observation Encoder model:
  - Take raw tool output (JSON, text, error)
  - Use LLM to generate a 1-2 sentence summary of what changed
  - Encode summary via State Encoder → state embedding
- This is the "LLM bridge" approach — works immediately, replaced later
- **Output:** `src/brain/stratus/ObservationEncoderV1.ts`

#### B.4.2 Build observation encoder (v2 — direct model)
- Trained Observation Encoder that maps tool outputs → state embeddings
- No LLM call needed — direct encoding
- Depends on: training pipeline (Workstream E)
- Interface-compatible with v1 (swap via config)
- **Output:** `src/brain/stratus/ObservationEncoderV2.ts`

#### B.4.3 Build goal proximity monitor
- After each step, compute cosine(state_emb, goal_emb)
- Track proximity curve over time
- Termination conditions:
  - Proximity > threshold (goal reached)
  - Proximity stagnant for N steps (stuck)
  - Max steps exceeded (hard limit)
  - Recovery probe fires (failure detected)
- **Output:** `src/brain/stratus/GoalMonitor.ts`

#### B.4.4 Build recovery & backtracking system
- When recovery probe detects failure:
  1. Log failure state and action that caused it
  2. Roll back to last known good state (from trajectory)
  3. Exclude failed action from candidates
  4. Re-plan from recovered state
- When goal proximity is stagnant:
  1. Switch from primary probe to planning probe
  2. Attempt longer-horizon tree search
  3. If still stuck, generate recovery plan via LLM
- **Output:** `src/brain/stratus/RecoveryManager.ts`

#### B.4.5 Build turn orchestrator
- The main loop that ties everything together:
  1. Receive message from Gateway
  2. Extract goal
  3. Assemble initial state
  4. Loop: rank → search → generate → execute → observe → check
  5. On completion: generate summary via LLM
  6. Return response to Gateway
- Implements `IBrain.processTurn()`
- **Output:** `src/brain/stratus/StratusBrain.ts`

### B.5 Observability & Debugging

#### B.5.1 Build decision trace logger
- Every turn logs a structured trace:
  ```json
  {
    "step": 3,
    "state_text": "...",
    "state_embedding_hash": "abc123",
    "goal_proximity": 0.72,
    "probe_rankings": [
      {"tool": "check_logs", "score": 0.89},
      {"tool": "restart_service", "score": 0.71}
    ],
    "tree_search_used": true,
    "tree_search_result": { ... },
    "action_selected": "check_logs",
    "generation_needed": false,
    "tool_output_summary": "Found 3 error entries in last 5 minutes",
    "new_goal_proximity": 0.78,
    "latency_ms": { "probe": 2, "tree_search": 85, "execution": 340, "observation": 45 }
  }
  ```
- Stored in session directory for debugging
- **Output:** `src/brain/stratus/DecisionTraceLogger.ts`

#### B.5.2 Build Stratus Brain dashboard
- Web UI (served by Gateway) showing:
  - Real-time goal proximity curve
  - Action rankings per step
  - State embedding trajectory visualization (2D projection)
  - LLM generation calls (count, cost, latency)
  - Tree search visualizations when used
- Built as OpenClaw Canvas extension (A2UI)
- **Output:** `src/ui/stratus-dashboard/`

#### B.5.3 Build performance profiler
- Track per-component latency:
  - State encoding: should be <10ms
  - Probe ranking: should be <5ms
  - Tree search: should be <500ms
  - LLM generation: variable (tracked separately)
  - Tool execution: variable (tracked separately)
  - Observation encoding: should be <50ms (v1), <10ms (v2)
- Alert if latency exceeds budget
- **Output:** `src/brain/stratus/PerformanceProfiler.ts`

---

## 4. Workstream C: Agent Builder Agent

**Goal:** Build the meta-agent — an agent powered by Stratus that builds,
tests, and deploys other Stratus agents. This is Agent #1.

### C.1 Agent Builder Tool Registry

The Agent Builder Agent needs its own specialized tools:

#### C.1.1 `analyze_domain` tool
- Input: domain description (natural language or structured)
- Process:
  1. Extract key entities, actions, workflows
  2. Identify common goals in this domain
  3. Map to existing training domains (87 available)
  4. Identify gaps needing new data/probes
- Output: structured domain analysis
- **Output:** `src/agent-builder/tools/analyze_domain.ts`

#### C.1.2 `generate_tool_registry` tool
- Input: domain analysis + list of APIs/tools available
- Process:
  1. For each tool/API endpoint:
     - Generate `rich_description` matching training format
     - Infer `effects` and `preconditions`
     - Determine `requires_generation` flag
     - Generate `generation_template` if needed
  2. Validate descriptions are distinct in action embedding space
  3. Check for missing capabilities (common actions without tools)
- Output: complete `agent.tools.yaml` file
- **Output:** `src/agent-builder/tools/generate_tool_registry.ts`

#### C.1.3 `generate_test_scenarios` tool
- Input: domain analysis + tool registry
- Process:
  1. Generate 10-20 representative test scenarios
  2. Each scenario: goal, expected tool sequence, success criteria
  3. Include edge cases: ambiguous goals, tool failures, multi-step workflows
  4. Generate both happy-path and failure scenarios
- Output: test scenario manifest
- **Output:** `src/agent-builder/tools/generate_test_scenarios.ts`

#### C.1.4 `select_probe` tool
- Input: domain analysis + available probes
- Process:
  1. Check if domain matches existing trained probes
  2. If yes: recommend probe + expected accuracy
  3. If partial match: recommend general probe with caveats
  4. If no match: recommend training a new probe (flag for Workstream E)
- Output: probe recommendation
- **Output:** `src/agent-builder/tools/select_probe.ts`

#### C.1.5 `train_probe` tool
- Input: domain, tool registry, training traces (optional)
- Process:
  1. If traces provided: train LoRA probe on customer data
  2. If no traces: generate synthetic trajectories from domain spec
  3. Train probe (calls probe training pipeline)
  4. Validate: probe accuracy on held-out test scenarios
  5. Return probe ID and metrics
- Output: trained probe weights + evaluation metrics
- **Output:** `src/agent-builder/tools/train_probe.ts`

#### C.1.6 `configure_agent` tool
- Input: domain, tool registry, probe, LLM preference, channels
- Process:
  1. Generate `openclaw.json` with Stratus extensions
  2. Set up skill directory with tool manifests
  3. Configure channel adapters
  4. Set memory templates (domain-relevant categories)
  5. Generate AGENTS.md (agent instructions/personality)
  6. Generate SOUL.md (agent persona)
- Output: complete agent configuration directory
- **Output:** `src/agent-builder/tools/configure_agent.ts`

#### C.1.7 `test_agent` tool
- Input: agent config directory + test scenarios
- Process:
  1. Start agent in sandbox mode
  2. Run each test scenario
  3. Record: actions taken, goal proximity curve, success/failure
  4. Compare against expected tool sequences
  5. Measure: steps to completion, LLM calls made, latency
  6. Generate test report
- Output: test results with pass/fail per scenario
- **Output:** `src/agent-builder/tools/test_agent.ts`

#### C.1.8 `deploy_agent` tool
- Input: tested agent config + deployment target
- Process:
  1. Package agent (config + skills + probe + dependencies)
  2. Deploy to target:
     - Local: install to `~/.openclaw/agents/<name>/`
     - Docker: build container with Stratus sidecar + agent
     - Cloud: deploy to Fly.io / managed hosting
  3. Configure channels (Slack webhook, Discord bot token, etc.)
  4. Run smoke test on deployed instance
  5. Return deployment URL/status
- Output: deployment confirmation + access details
- **Output:** `src/agent-builder/tools/deploy_agent.ts`

#### C.1.9 `iterate_agent` tool
- Input: deployed agent + feedback/traces
- Process:
  1. Analyze traces from production usage
  2. Identify: suboptimal actions, missing tools, probe failures
  3. Suggest: tool registry updates, probe retraining, config changes
  4. Apply changes and re-test
- Output: iteration report + updated agent
- **Output:** `src/agent-builder/tools/iterate_agent.ts`

### C.2 Agent Builder Configuration

#### C.2.1 Configure Agent Builder's own tool registry
- Rich descriptions for all 9 tools above
- Embed in action encoder space
- Validate separation between tools
- **Output:** `agents/agent-builder/agent.tools.yaml`

#### C.2.2 Configure Agent Builder's probe
- Initially: use general `planning-v2` probe
- Later: train dedicated `agent-building-v1` probe on agent construction traces
- **Output:** `agents/agent-builder/probe_config.yaml`

#### C.2.3 Write Agent Builder persona
- AGENTS.md: instructions for building agents
- SOUL.md: persona (methodical, thorough, quality-focused)
- Include: best practices for tool description writing, testing strategies
- **Output:** `agents/agent-builder/AGENTS.md`, `agents/agent-builder/SOUL.md`

#### C.2.4 Configure Agent Builder's Stratus settings
- Tree search: enabled (agent building has ambiguous decision points)
- Max steps: 50 (building an agent is a multi-step task)
- Goal proximity threshold: 0.90 (high bar — agent must be well-configured)
- **Output:** `agents/agent-builder/openclaw.json`

### C.3 Agent Builder Workflows

#### C.3.1 Design the "build agent from scratch" workflow
- User input: domain description + available APIs/tools + preferences
- Workflow:
  1. `analyze_domain` → domain structure
  2. `generate_tool_registry` → tool definitions
  3. `select_probe` → probe recommendation
  4. `train_probe` (if needed) → custom probe
  5. `generate_test_scenarios` → test suite
  6. `configure_agent` → agent config
  7. `test_agent` → test results
  8. Fix any failures → iterate
  9. `deploy_agent` → live agent
- **Output:** Workflow documentation + integration tests

#### C.3.2 Design the "clone and customize" workflow
- User input: existing agent + modifications needed
- Workflow:
  1. Copy existing agent config
  2. `analyze_domain` → identify what's different
  3. Modify tool registry for new domain
  4. Retrain or swap probe
  5. Update persona/instructions
  6. Test against new scenarios
  7. Deploy
- **Output:** Workflow documentation + integration tests

#### C.3.3 Design the "improve existing agent" workflow
- User input: deployed agent + production traces + feedback
- Workflow:
  1. `iterate_agent` → analysis of issues
  2. Update tool descriptions (richer effects, better preconditions)
  3. Retrain probe on production traces
  4. Add missing tools
  5. Re-test
  6. Hot-deploy update
- **Output:** Workflow documentation + integration tests

### C.4 Agent Templates

#### C.4.1 Build template system
- Templates are pre-configured agent skeletons:
  ```
  templates/
    devops-incident/
      agent.tools.yaml      # pre-defined DevOps tools
      test_scenarios.yaml   # standard test cases
      AGENTS.md             # DevOps agent instructions
      SOUL.md               # DevOps agent persona
    sales-pipeline/
      ...
    customer-support/
      ...
    personal-assistant/
      ...
  ```
- Agent Builder uses templates to accelerate builds
- **Output:** `src/agent-builder/templates/TemplateManager.ts`

#### C.4.2 Create DevOps Incident Response template
- Based on `devops_incident` training domain
- Tools: get_active_alerts, check_logs, restart_service, rollback_deployment, notify_team, write_postmortem, etc.
- Test scenarios: service outage, memory leak, deployment failure, cascading failure
- **Output:** `templates/devops-incident/`

#### C.4.3 Create Sales Pipeline template
- Based on `sales_pipeline` training domain
- Tools: update_deal_stage, send_email, schedule_demo, create_proposal, log_activity, etc.
- Test scenarios: new lead qualification, deal progression, objection handling, close
- **Output:** `templates/sales-pipeline/`

#### C.4.4 Create Customer Support template
- Based on `customer_support` training domain
- Tools: search_knowledge_base, create_ticket, escalate, send_response, update_status, etc.
- Test scenarios: known issue, unknown issue, escalation, follow-up
- **Output:** `templates/customer-support/`

#### C.4.5 Create Personal Assistant template
- Cross-domain: scheduling, email, research, task management
- Tools: schedule_meeting, send_email, web_search, create_task, set_reminder, etc.
- Test scenarios: meeting scheduling, email triage, research request, daily briefing
- **Output:** `templates/personal-assistant/`

---

## 5. Workstream D: Agent Runtime & Deployment

**Goal:** Package and deploy agents reliably at scale. Support multiple
deployment targets and multi-agent orchestration.

### D.1 Agent Packaging

#### D.1.1 Define agent package format
- An agent package is a self-contained directory:
  ```
  my-agent/
    openclaw.json           # full config with Stratus settings
    AGENTS.md               # agent instructions
    SOUL.md                 # agent persona
    agent.tools.yaml        # tool registry
    skills/                 # OpenClaw skill directories
    probe/                  # probe weights (if custom)
      probe_config.yaml
      weights.pt
    tests/
      scenarios.yaml        # test scenarios
      results/              # last test run results
    .stratus/
      tool_embeddings.bin   # cached action embeddings
  ```
- **Output:** `src/packaging/AgentPackage.ts`
- **v2 migration constraint:** This format is language-agnostic by design. ALL files are
  YAML, JSON, Markdown, or binary (weights). No `.ts` files in the package. v2 loads
  the exact same packages with a Python loader — zero conversion needed.

#### D.1.2 Build agent packager
- Takes agent config directory → validates → creates package
- Validates: all skills exist, probe weights valid, config complete
- Computes checksums for integrity verification
- **Output:** `src/packaging/AgentPackager.ts`

#### D.1.3 Build agent loader
- Takes agent package → sets up runtime environment
- Loads: config, tools, skills, probe, embeddings
- Validates compatibility with current Stratus model version
- **Output:** `src/packaging/AgentLoader.ts`

### D.2 Deployment Targets

#### D.2.1 Local deployment
- Install agent to `~/.openclaw/agents/<name>/`
- Register with local Gateway
- Start Stratus sidecar (shared across local agents or per-agent)
- **Output:** `src/deploy/LocalDeployer.ts`

#### D.2.2 Docker deployment
- Dockerfile template:
  - Base: OpenClaw + Stratus sidecar
  - Copy: agent package
  - Expose: Gateway port
  - GPU support: nvidia-docker for Stratus inference
  - CPU fallback: ONNX runtime for CPU-only hosts
- Docker Compose for multi-agent setups
- **Output:** `src/deploy/DockerDeployer.ts` + `docker/Dockerfile.agent`

#### D.2.3 Cloud deployment (Fly.io)
- fly.toml template for agent deployment
- Persistent volume for memory/state
- GPU machine for Stratus inference
- Auto-scaling configuration
- Secrets management for API keys
- **Output:** `src/deploy/FlyDeployer.ts` + `fly/fly.toml.template`

#### D.2.4 Multi-agent deployment
- Multiple agents sharing a single Stratus sidecar
- Agent routing based on channel/context
- Shared tool embedding cache (agents in same domain share embeddings)
- Inter-agent communication via OpenClaw session tools
- **Output:** `src/deploy/MultiAgentOrchestrator.ts`

### D.3 Agent Lifecycle Management

#### D.3.1 Build agent version manager
- Track agent versions (config + probe + tools)
- Support rollback to previous version
- Blue/green deployment for zero-downtime updates
- **Output:** `src/lifecycle/VersionManager.ts`

#### D.3.2 Build agent health monitor
- Track: response latency, goal completion rate, error rate, LLM cost
- Alert on: degraded performance, probe accuracy drop, sidecar unhealthy
- Dashboard integration (Workstream B.5.2)
- **Output:** `src/lifecycle/HealthMonitor.ts`

#### D.3.3 Build agent auto-updater
- When Stratus model is updated (new checkpoint):
  1. Load new model in sidecar
  2. Re-embed all tools with new ActionEncoder
  3. Run smoke tests
  4. Swap to new model if tests pass
  5. Rollback if tests fail
- **Output:** `src/lifecycle/AutoUpdater.ts`

---

## 6. Workstream E: Probe Training Pipeline

**Goal:** Automated pipeline for training domain-specific probes from agent
traces or synthetic data.

### E.1 Training Data Pipeline

#### E.1.1 Build trace collector
- Capture (state_emb, action_taken, goal_emb, outcome) tuples from live agents
- Format compatible with probe training pipeline
- Privacy controls: opt-in, anonymization, data retention policy
- **Output:** `src/probes/TraceCollector.ts`

#### E.1.2 Build synthetic trajectory generator
- Input: domain spec + tool registry
- Generate realistic multi-step trajectories:
  1. Sample a goal from domain
  2. Simulate tool sequence using world model rollouts
  3. Add realistic variations (failures, retries, alternative paths)
  4. Label optimal vs suboptimal sequences
- Reuses: `v4_training/synthetic/generate_trajectories_v2.py`
- **Output:** `src/probes/SyntheticTrajectoryGenerator.ts` (calls Python backend)

#### E.1.3 Build training data validator
- Check: sufficient volume (min 500 trajectories for LoRA probe)
- Check: action coverage (all tools appear in at least 10 trajectories)
- Check: goal diversity (at least 5 distinct goal types)
- Check: trajectory quality (optimal paths actually reach goals)
- **Output:** `src/probes/TrainingDataValidator.ts`

### E.2 Probe Training

#### E.2.1 Build LoRA probe trainer
- Wraps existing `v4_models/probes/probe_factory.py`
- Trains lightweight LoRA adapter (~5M params) on domain data
- Hyperparameter defaults optimized for small datasets (500-5000 trajectories)
- Validation split: 80/20, early stopping on validation loss
- **Output:** `src/probes/ProbeTrainer.ts` (calls Python backend)

#### E.2.2 Build probe evaluator
- Evaluate trained probe on held-out test scenarios:
  - Action selection accuracy (did it pick the right tool?)
  - Ranking quality (NDCG@5 of tool rankings)
  - Recovery detection (does it catch failures?)
  - Goal completion rate (end-to-end with world model rollouts)
- Compare against general probe baseline
- **Output:** `src/probes/ProbeEvaluator.ts`

#### E.2.3 Build probe registry integration
- Register trained probe in Stratus ProbeRegistry
- Assign to agent via config
- Support A/B testing: run new probe alongside old, compare metrics
- **Output:** `src/probes/ProbeRegistryBridge.ts`

### E.3 Continuous Probe Improvement

#### E.3.1 Build probe performance tracker
- Monitor deployed probe accuracy over time
- Detect: accuracy degradation, distribution shift, new action patterns
- Alert when retraining is recommended
- **Output:** `src/probes/ProbePerformanceTracker.ts`

#### E.3.2 Build automated retraining scheduler
- When performance degrades below threshold:
  1. Collect recent traces (last N days)
  2. Combine with original training data
  3. Retrain probe
  4. Evaluate against test scenarios
  5. Deploy if improved, alert if not
- Wraps existing `v4_models/probes/retrain.py`
- **Output:** `src/probes/RetrainScheduler.ts`

---

## 7. Workstream F: SDK & Developer Experience

**Goal:** Make it easy for developers to build agents, integrate Stratus into
existing systems, and extend the platform.

### F.1 CLI Tool

#### F.1.1 Build `stratus-claw` CLI
- Commands:
  ```
  stratus-claw init [template]        # Create new agent from template
  stratus-claw build                  # Build agent (validate, embed tools, package)
  stratus-claw test                   # Run test scenarios
  stratus-claw deploy [target]        # Deploy (local|docker|fly)
  stratus-claw run                    # Start agent locally
  stratus-claw logs                   # Stream agent logs
  stratus-claw trace [session]        # Show decision trace for a session
  stratus-claw probe train [domain]   # Train a custom probe
  stratus-claw probe eval [probe]     # Evaluate a probe
  stratus-claw agent list             # List deployed agents
  stratus-claw agent status [name]    # Agent health/metrics
  stratus-claw agent update [name]    # Update deployed agent
  ```
- **Output:** `src/cli/`

#### F.1.2 Build interactive agent builder
- `stratus-claw create` — guided wizard:
  1. "What domain?" → domain analysis
  2. "What tools/APIs?" → tool registry generation
  3. "What LLM?" → provider config
  4. "What channels?" → channel setup
  5. "Custom probe?" → probe selection/training
  6. Test → Deploy
- **Output:** `src/cli/create-wizard.ts`

### F.2 TypeScript SDK

#### F.2.1 Build Stratus Agent SDK
- For developers building agents programmatically:
  ```typescript
  import { StratusAgent, ToolRegistry, ProbeConfig } from '@formation-ai/stratus-claw';

  const agent = new StratusAgent({
    name: 'my-agent',
    tools: ToolRegistry.fromYaml('./tools.yaml'),
    probe: ProbeConfig.general('tool-use-v2'),
    llm: { provider: 'anthropic', model: 'claude-sonnet-4-5-20250514' },
    stratus: { model: './models/v6-latest.pt' }
  });

  // Run a single task
  const result = await agent.run('Deploy the latest build to staging');

  // Start as persistent agent
  await agent.start({ channels: ['slack', 'cli'] });
  ```
- **Output:** `packages/sdk/`

#### F.2.2 Build tool definition helpers
- Utilities for creating tool registry entries:
  ```typescript
  const tool = defineTool({
    name: 'check_deployment_status',
    domain: 'devops',
    description: 'Check the current deployment status of a service',
    effects: ['deployment status retrieved', 'service health known'],
    preconditions: ['service name provided'],
    parameters: z.object({ service: z.string(), environment: z.string() }),
    handler: async (params) => { ... }
  });
  ```
- Auto-generates `rich_description` from structured input
- Validates against action encoder (warns if too similar to existing tools)
- **Output:** `packages/sdk/tools.ts`

### F.3 Documentation

#### F.3.1 Write getting started guide
- 5-minute quickstart: install, create agent, run locally
- **Output:** `docs/getting-started.md`

#### F.3.2 Write architecture guide
- How Stratus Brain works, how it differs from ReAct
- When/why tree search activates
- How probes select actions
- **Output:** `docs/architecture.md`

#### F.3.3 Write tool authoring guide
- How to write good tool descriptions that Stratus understands
- Rich description format explained
- How to validate tool separation in embedding space
- **Output:** `docs/tool-authoring.md`

#### F.3.4 Write probe training guide
- When to train a custom probe vs use general
- Data requirements and collection strategies
- Training configuration and evaluation
- **Output:** `docs/probe-training.md`

#### F.3.5 Write deployment guide
- Local, Docker, Fly.io deployment walkthroughs
- Multi-agent configuration
- Monitoring and maintenance
- **Output:** `docs/deployment.md`

---

## 8. Workstream G: Testing & Validation

**Goal:** Comprehensive testing at every level — unit, integration, end-to-end,
and comparative benchmarks.

### G.1 Unit Tests

#### G.1.1 Brain interface tests
- `IBrain` contract tests — any brain implementation must pass
- State encoding round-trip tests
- Action ranking determinism tests
- **Output:** `tests/unit/brain/`
- **v2 migration note:** Write tests as behavioral assertions against IBrain interface,
  not StratusBrain internals. These same test cases (same inputs, same expected outputs)
  must be translatable to pytest for v2. Keep test data in JSON fixtures, not inline TS.

#### G.1.2 Tool registry tests
- Skill-to-tool conversion accuracy
- Embedding cache invalidation
- Tool search correctness
- **Output:** `tests/unit/tools/`

#### G.1.3 State management tests
- State assembly from various input combinations
- Goal extraction from conversation contexts
- Dynamic state tracking accuracy
- **Output:** `tests/unit/state/`

### G.2 Integration Tests

#### G.2.1 Sidecar integration tests
- Startup, health check, shutdown lifecycle
- Encoding correctness (compare to Python-direct results)
- Batch encoding performance
- Hot-reload model swap
- **Output:** `tests/integration/sidecar/`

#### G.2.2 Brain-Gateway integration tests
- Message → Brain → Response flow
- Multi-turn conversation handling
- Channel-specific formatting
- **Output:** `tests/integration/gateway/`

#### G.2.3 Agent Builder integration tests
- Build agent from template → test → deploy
- End-to-end agent construction workflow
- Probe training → deployment pipeline
- **Output:** `tests/integration/agent-builder/`

### G.3 End-to-End Tests

#### G.3.1 Design standard benchmark suite
- 20 scenarios across 4 domains (DevOps, Sales, Support, Personal)
- Each scenario: goal, available tools, expected outcome, max steps
- Graded on: completion, efficiency (steps), cost (LLM calls), latency
- **Output:** `tests/e2e/benchmark/`

#### G.3.2 Stratus Brain vs ReAct Brain comparative benchmark
- Run same 20 scenarios through both brain implementations
- Compare:
  | Metric | ReAct | Stratus |
  |--------|-------|---------|
  | Completion rate | ? | ? |
  | Avg steps to complete | ? | ? |
  | LLM calls per task | ? | ? |
  | Avg latency per step | ? | ? |
  | Total cost per task | ? | ? |
- This is THE benchmark that proves the value proposition
- **Output:** `tests/e2e/comparative/`

#### G.3.3 Multi-agent coordination tests
- Two agents collaborating on a task
- Agent-to-agent communication via session tools
- Shared Stratus sidecar performance under load
- **Output:** `tests/e2e/multi-agent/`

### G.4 Stress & Performance Tests

#### G.4.1 Sidecar throughput benchmark
- Encoding requests per second (single client, batched)
- Concurrent client handling (10, 50, 100 agents)
- Memory usage under load
- GPU utilization patterns
- **Output:** `tests/perf/sidecar/`

#### G.4.2 Agent response latency benchmark
- End-to-end: message in → response out
- Breakdown: encoding + probe + search + generation + execution
- P50, P95, P99 latencies
- **Output:** `tests/perf/latency/`

---

## 9. Workstream H: First Vertical Agents

**Goal:** Build 3-4 production-quality agents using the Agent Builder Agent.
These validate the entire pipeline and become showcase products.

### H.1 DevOps Incident Response Agent

#### H.1.1 Define domain spec
- Integrations: PagerDuty, Datadog, AWS, GitHub, Slack
- Goal types: resolve incident, investigate alert, perform runbook
- **Output:** `agents/devops-incident/domain_spec.md`

#### H.1.2 Build via Agent Builder Agent
- Feed domain spec to Agent Builder
- Generate tool registry from API specs
- Train devops-specific probe (from training domain data)
- Test against 15 incident scenarios
- **Output:** `agents/devops-incident/` (complete agent package)

#### H.1.3 Deploy and validate
- Deploy to internal dogfood environment
- Run against simulated incidents for 1 week
- Collect traces, measure metrics, iterate
- **Output:** Deployment + metrics report

### H.2 Sales Pipeline Agent

#### H.2.1 Define domain spec
- Integrations: Salesforce/HubSpot, Gmail, Calendar, LinkedIn
- Goal types: progress deal, qualify lead, schedule meeting, send follow-up
- **Output:** `agents/sales-pipeline/domain_spec.md`

#### H.2.2 Build via Agent Builder Agent
- Same process as H.1.2
- **Output:** `agents/sales-pipeline/`

#### H.2.3 Deploy and validate
- Same process as H.1.3
- **Output:** Deployment + metrics report

### H.3 Customer Support Agent

#### H.3.1 Define domain spec
- Integrations: Zendesk/Intercom, knowledge base, Slack, email
- Goal types: resolve ticket, escalate issue, answer question, update status
- **Output:** `agents/customer-support/domain_spec.md`

#### H.3.2 Build via Agent Builder Agent
- Same process as H.1.2
- **Output:** `agents/customer-support/`

#### H.3.3 Deploy and validate
- Same process as H.1.3
- **Output:** Deployment + metrics report

### H.4 Personal Productivity Agent

#### H.4.1 Define domain spec
- Integrations: Calendar, Email, Todoist/Notion, Web Search, Slack
- Goal types: schedule meeting, triage inbox, research topic, daily briefing
- **Output:** `agents/personal-assistant/domain_spec.md`

#### H.4.2 Build via Agent Builder Agent
- Same process as H.1.2
- **Output:** `agents/personal-assistant/`

#### H.4.3 Deploy and validate
- Same process as H.1.3
- **Output:** Deployment + metrics report

---

## 10. Dependencies & Parallelization Map

### 10.1 Dependency Graph

```
A.1 (Fork Setup)
  ├── A.2 (Brain Extraction) ──────────────────────┐
  ├── A.3 (Skill-to-Tool Bridge)                    │
  ├── A.4 (Memory Enhancement)                      │
  └── A.5 (Configuration)                           │
                                                    │
B.1 (Stratus Runtime Bridge) ◄──────────────────────┘
  ├── B.2 (State Management)
  ├── B.3 (Action Selection)
  ├── B.4 (Observation & Loop)
  └── B.5 (Observability)
       │
       ├── C.1 (Agent Builder Tools) ◄── B.3, B.4
       ├── C.2 (Agent Builder Config)
       ├── C.3 (Agent Builder Workflows) ◄── C.1, C.2
       └── C.4 (Agent Templates)
            │
            ├── D.1 (Agent Packaging) ◄── C.3
            ├── D.2 (Deployment Targets)
            ├── D.3 (Lifecycle Management)
            │
            ├── E.1 (Training Data Pipeline)
            ├── E.2 (Probe Training)
            └── E.3 (Continuous Improvement)
                 │
                 ├── F.1 (CLI) ◄── D.1, D.2
                 ├── F.2 (SDK)
                 └── F.3 (Documentation)
                      │
                      ├── G.1-G.4 (Testing) ◄── all above
                      │
                      └── H.1-H.4 (Vertical Agents) ◄── G.3
```

### 10.2 Parallelization Opportunities

**Phase 1 — Can all start immediately (no dependencies):**

| Track | Tasks | Est. Effort |
|-------|-------|-------------|
| Agent 1 | A.1.1, A.1.2, A.1.3 (Fork setup) | 1 day |
| Agent 2 | A.3.1 (Skill format analysis) | 0.5 day |
| Agent 3 | B.1.1 (Bridge evaluation) | 1 day |
| Agent 4 | C.4.2-C.4.5 (Agent templates — just content, no code) | 2 days |
| Agent 5 | F.3.1-F.3.5 (Documentation — can write against spec) | 2 days |
| Agent 6 | E.1.2 (Synthetic trajectory generator — reuses existing code) | 1 day |

**Phase 2 — After fork is ready (A.1 complete):**

| Track | Tasks | Blocked By |
|-------|-------|-----------|
| Agent 1 | A.2.1-A.2.5 (Brain extraction) | A.1 |
| Agent 2 | A.3.2-A.3.5 (Tool registry) | A.3.1 |
| Agent 3 | A.4.1-A.4.3 (Memory enhancement) | A.1 |
| Agent 4 | A.5.1-A.5.3 (Configuration) | A.1 |
| Agent 5 | B.1.2-B.1.5 (Stratus sidecar) | B.1.1 |

**Phase 3 — After Brain interface defined (A.2 complete):**

| Track | Tasks | Blocked By |
|-------|-------|-----------|
| Agent 1 | B.2.1-B.2.4 (State management) | A.2, B.1 |
| Agent 2 | B.3.1-B.3.4 (Action selection) | A.2, B.1, A.3 |
| Agent 3 | B.4.1-B.4.5 (Observation & loop) | A.2, B.1 |
| Agent 4 | B.5.1-B.5.3 (Observability) | A.2 |
| Agent 5 | G.1.1-G.1.3 (Unit tests — test against interface) | A.2 |

**Phase 4 — After Stratus Brain works (B complete):**

| Track | Tasks | Blocked By |
|-------|-------|-----------|
| Agent 1 | C.1.1-C.1.9 (Agent Builder tools) | B |
| Agent 2 | C.2.1-C.2.4 (Agent Builder config) | B |
| Agent 3 | D.1.1-D.1.3 (Agent packaging) | A.5, B |
| Agent 4 | D.2.1-D.2.4 (Deployment targets) | D.1 |
| Agent 5 | E.2.1-E.2.3 (Probe training pipeline) | B, E.1 |
| Agent 6 | F.1.1-F.1.2 (CLI) | D.1 |
| Agent 7 | F.2.1-F.2.2 (SDK) | B |

**Phase 5 — After Agent Builder works (C complete):**

| Track | Tasks | Blocked By |
|-------|-------|-----------|
| Agent 1 | H.1 (DevOps agent) | C, D |
| Agent 2 | H.2 (Sales agent) | C, D |
| Agent 3 | H.3 (Support agent) | C, D |
| Agent 4 | H.4 (Personal agent) | C, D |
| Agent 5 | G.3.2 (Comparative benchmark) | B, G.3.1 |

### 10.3 Critical Path

```
A.1 → A.2 → B.1 → B.2/B.3/B.4 → B.4.5 (StratusBrain) → C.1 → C.3 → H.1
 │                                                          │
 └──────────────────────────────────────────────────────────┘
                    ~4-6 weeks
```

The critical path runs through: fork → brain extraction → sidecar → state/action/observation → turn orchestrator → agent builder tools → agent builder workflows → first vertical agent.

Everything else (templates, docs, tests, SDK, deployment) can be built in parallel by other agents/developers.

---

## 11. Metrics & Success Criteria

### 11.1 Stratus Brain Performance

| Metric | Target | How Measured |
|--------|--------|-------------|
| Action selection latency (probe only) | <5ms | PerformanceProfiler |
| Action selection latency (with tree search) | <500ms | PerformanceProfiler |
| Goal completion rate | >80% on benchmark | E2E tests |
| Steps to completion (vs ReAct) | 30% fewer | Comparative benchmark |
| LLM calls per task (vs ReAct) | 70% fewer | Comparative benchmark |
| Cost per task (vs ReAct) | 50% lower | Comparative benchmark |
| Decision accuracy (right tool selected) | >85% | Probe evaluation |

### 11.2 Agent Builder Performance

| Metric | Target | How Measured |
|--------|--------|-------------|
| Time to build agent from template | <10 minutes | Agent Builder logs |
| Time to build agent from scratch | <30 minutes | Agent Builder logs |
| Agent test pass rate (first build) | >70% | Agent Builder test results |
| Agent test pass rate (after iteration) | >90% | Agent Builder test results |

### 11.3 Platform Health

| Metric | Target | How Measured |
|--------|--------|-------------|
| Sidecar uptime | >99.9% | HealthMonitor |
| Sidecar encoding throughput | >1000 req/s | Perf tests |
| Agent startup time | <5s (local), <30s (cloud) | Deploy tests |
| Concurrent agents per sidecar | >10 | Stress tests |

---

## 12. Decision Log

| # | Decision | Rationale | Date |
|---|----------|-----------|------|
| 1 | Fork OpenClaw (not build from scratch) | 163k stars, 5,700+ skills, 50+ channels. Building harness from scratch is years of work. Fork and replace the brain. | 2026-03-26 |
| 2 | HTTP sidecar for v1 (not ONNX) | Ship fast. Stratus API already exists. ONNX export is optimization for v2 when latency matters at scale. | 2026-03-26 |
| 3 | LLM bridge for Observation Encoder v1 | Trained Observation Encoder doesn't exist yet. LLM summarization → State Encoder is a working bridge. Replace with direct model when trained. | 2026-03-26 |
| 4 | Agent Builder Agent as Agent #1 | Recursive value: the factory builds the factory. Every subsequent agent is cheaper. Proves the entire stack end-to-end. | 2026-03-26 |
| 5 | Stratus Brain replaces Brain component entirely (not plugin) | Plugin would be a hack — Stratus needs to control the loop, termination, backtracking. Full Brain replacement is the clean architecture. | 2026-03-26 |
| 6 | Brain interface contract (IBrain) | Allows ReAct and Stratus to coexist. Existing tests keep passing. Clean migration path. | 2026-03-26 |
| 7 | Keep OpenClaw Gateway/Memory/Skills/Heartbeat unchanged | These are battle-tested. Channels, scheduling, skill marketplace — no reason to rebuild. | 2026-03-26 |
| 8 | Per-agent probes (not one-size-fits-all) | Domain-specific LoRA probes are cheap (~5M params) and dramatically improve action selection for specialized agents. General probes are fallback. | 2026-03-26 |
| 9 | Templates accelerate agent building | Pre-configured tool registries, test scenarios, and personas for common domains. Agent Builder starts from templates, not blank slate. | 2026-03-26 |
| 10 | Training data format canonical, platform adapters for real-world | Model learns dynamics from canonical format. Real-world traces are preprocessed by platform-specific adapters (~10 covers 90% market). | 2026-03-26 |
| 11 | Rich context excluded from pre-training, handled by probes | Prevents cos_consec collapse. Context-dependent preferences learned via post-training and per-customer probes. | 2026-03-26 |
| 12 | v1 in TypeScript (OpenClaw fork), v2 in Python-native | Ship fast with battle-tested harness (v1). Rewrite when brain is validated and we know exactly what harness we need (v2). Bridge tax (~5-10ms) negligible vs tool execution latency. | 2026-03-26 |
| 13 | Design constraints for clean v1→v2 migration | IBrain as only contract, StratusClient as only Stratus touchpoint, JSON-serializable tool registry, language-agnostic agent packages, behavioral tests. Ensures v2 is a rewrite, not an untangling. | 2026-03-26 |
| 14 | Sidecar RPC = v2 internal API | HTTP endpoints map 1:1 to Python functions. In v2, StratusClient method calls become direct function calls with identical signatures. Zero design waste. | 2026-03-26 |

---

## Appendix A: Glossary

| Term | Definition |
|------|-----------|
| **Stratus Brain** | The world model-based planning component that replaces OpenClaw's ReAct Brain |
| **Sidecar** | Python microservice running the Stratus V6 model, called by the TypeScript Brain |
| **Probe** | Lightweight policy head (~5M params) that ranks actions given (state, goal) |
| **Rich Description** | Tool description in training format: "action_type (domain). description. effects: ..." |
| **Tree Search** | Beam search over world model rollouts for multi-step planning |
| **Goal Proximity** | cosine(state_embedding, goal_embedding) — how close the agent is to its goal |
| **Observation Encoder** | Component that encodes real tool outputs into state embedding space |
| **Agent Package** | Self-contained directory with config, tools, probe, and skills for one agent |
| **Agent Builder Agent** | The meta-agent that constructs and deploys other agents |
| **Tool Registry** | Collection of tool definitions with rich descriptions and cached embeddings |
| **Platform Adapter** | Preprocessor that converts real-world traces (LangSmith, OTEL) to canonical format |
| **v1** | TypeScript implementation phase — OpenClaw fork with Stratus Brain via HTTP sidecar |
| **v2** | Python-native implementation phase — single-process, zero-bridge, purpose-built harness |
| **Bridge Tax** | The ~5-10ms latency overhead of TypeScript↔Python HTTP calls in v1 (eliminated in v2) |

---

## Appendix B: File Tree (Projected)

```
stratus-claw/                          # OpenClaw fork
├── src/
│   ├── brain/
│   │   ├── IBrain.ts                  # Brain interface contract
│   │   ├── BrainRegistry.ts           # Brain selection (react|stratus)
│   │   ├── ReActBrainAdapter.ts       # Wraps existing ReAct behind IBrain
│   │   └── stratus/
│   │       ├── StratusBrain.ts        # Main turn orchestrator
│   │       ├── StratusClient.ts       # RPC client to sidecar
│   │       ├── StratusRPC.ts          # RPC type definitions
│   │       ├── SidecarManager.ts      # Sidecar lifecycle
│   │       ├── StateAssembler.ts      # Context → canonical state text
│   │       ├── StateEncoderBridge.ts  # State text → embedding
│   │       ├── GoalExtractor.ts       # User message → goal embedding
│   │       ├── DynamicStateTracker.ts # Step-by-step state tracking
│   │       ├── ActionRanker.ts        # Probe-based action ranking
│   │       ├── TreeSearch.ts          # Multi-step beam search
│   │       ├── GenerationRouter.ts    # LLM calls for content generation
│   │       ├── ActionExecutor.ts      # Tool execution bridge
│   │       ├── ObservationEncoderV1.ts # LLM-bridge observation encoder
│   │       ├── ObservationEncoderV2.ts # Direct model (future)
│   │       ├── GoalMonitor.ts         # Termination detection
│   │       ├── RecoveryManager.ts     # Failure detection & backtracking
│   │       ├── DecisionTraceLogger.ts # Structured decision logs
│   │       └── PerformanceProfiler.ts # Latency tracking
│   ├── tools/
│   │   ├── ToolRegistryEntry.ts       # Tool definition types
│   │   ├── ToolRegistry.ts            # Tool management
│   │   ├── ToolEmbeddingCache.ts      # Cached action embeddings
│   │   └── SkillToToolConverter.ts    # OpenClaw skill → tool entry
│   ├── memory/
│   │   ├── StateTrajectoryStore.ts    # Embedding trajectory log
│   │   ├── TrajectoryMemoryBridge.ts  # Trajectory → markdown summary
│   │   └── TrajectoryReplay.ts        # Replay past sessions
│   ├── config/
│   │   ├── StratusConfig.ts           # Config types + defaults
│   │   ├── ConfigValidator.ts         # Startup validation
│   │   └── ConfigMigrator.ts          # OpenClaw → Stratus migration
│   ├── agent-builder/
│   │   └── tools/
│   │       ├── analyze_domain.ts
│   │       ├── generate_tool_registry.ts
│   │       ├── generate_test_scenarios.ts
│   │       ├── select_probe.ts
│   │       ├── train_probe.ts
│   │       ├── configure_agent.ts
│   │       ├── test_agent.ts
│   │       ├── deploy_agent.ts
│   │       └── iterate_agent.ts
│   ├── packaging/
│   │   ├── AgentPackage.ts
│   │   ├── AgentPackager.ts
│   │   └── AgentLoader.ts
│   ├── deploy/
│   │   ├── LocalDeployer.ts
│   │   ├── DockerDeployer.ts
│   │   ├── FlyDeployer.ts
│   │   └── MultiAgentOrchestrator.ts
│   ├── lifecycle/
│   │   ├── VersionManager.ts
│   │   ├── HealthMonitor.ts
│   │   └── AutoUpdater.ts
│   ├── probes/
│   │   ├── TraceCollector.ts
│   │   ├── SyntheticTrajectoryGenerator.ts
│   │   ├── TrainingDataValidator.ts
│   │   ├── ProbeTrainer.ts
│   │   ├── ProbeEvaluator.ts
│   │   ├── ProbeRegistryBridge.ts
│   │   ├── ProbePerformanceTracker.ts
│   │   └── RetrainScheduler.ts
│   ├── cli/
│   │   ├── index.ts
│   │   └── create-wizard.ts
│   └── ui/
│       └── stratus-dashboard/
├── stratus_sidecar/
│   ├── server.py                      # FastAPI wrapping StratusBrain
│   └── rpc.py                         # RPC endpoint handlers
├── packages/
│   └── sdk/
│       ├── index.ts
│       └── tools.ts
├── agents/
│   └── agent-builder/
│       ├── openclaw.json
│       ├── AGENTS.md
│       ├── SOUL.md
│       ├── agent.tools.yaml
│       └── probe_config.yaml
├── templates/
│   ├── devops-incident/
│   ├── sales-pipeline/
│   ├── customer-support/
│   └── personal-assistant/
├── docker/
│   └── Dockerfile.agent
├── fly/
│   └── fly.toml.template
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   └── perf/
└── docs/
    ├── getting-started.md
    ├── architecture.md
    ├── tool-authoring.md
    ├── probe-training.md
    └── deployment.md
```
