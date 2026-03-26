"""
Stratus Sidecar — FastAPI server wrapping StratusBrain for the OpenClaw harness.

This is the bridge between the TypeScript harness and the Python world model.
Each endpoint maps 1:1 to a Python function — in v2, these become direct calls.

Endpoints:
  POST /encode_state    — state text → 1024-d embedding
  POST /encode_goal     — goal text → 1024-d embedding
  POST /encode_actions  — action texts → N×1024-d embeddings + FiLM params
  POST /probe_rank      — (state, goal, actions) → ranked action candidates
  POST /predict         — (state, action) → predicted next state embedding
  POST /tree_search     — (state, goal, actions, depth) → best action path
  POST /goal_proximity  — (state, goal) → cosine similarity score
  POST /detect_failure  — state → failure detection result
  GET  /health          — sidecar health check
  POST /reload          — hot-reload model checkpoint

@purpose FastAPI sidecar wrapping StratusBrain for TypeScript harness RPC
@spec AGENT_FACTORY_SPEC.md#b12-define-rpc-interface
"""

import logging
import os
import time
from contextlib import asynccontextmanager
from typing import List, Optional

import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Request / Response Models
# ---------------------------------------------------------------------------

class EncodeStateRequest(BaseModel):
    text: str

class EncodeStateResponse(BaseModel):
    embedding: List[float]
    dim: int
    encoding_ms: float

class EncodeGoalRequest(BaseModel):
    text: str

class EncodeGoalResponse(BaseModel):
    embedding: List[float]
    dim: int
    encoding_ms: float

class EncodeActionsRequest(BaseModel):
    texts: List[str]

class ActionEmbedding(BaseModel):
    text: str
    embedding: List[float]

class EncodeActionsResponse(BaseModel):
    embeddings: List[ActionEmbedding]
    dim: int
    count: int
    encoding_ms: float

class ProbeRankRequest(BaseModel):
    state_embedding: List[float]
    goal_embedding: List[float]
    action_embeddings: List[List[float]]
    action_labels: List[str]
    top_k: int = 10
    probe_id: str = "planning-v2"

class RankedAction(BaseModel):
    action: str
    score: float
    rank: int

class ProbeRankResponse(BaseModel):
    ranked_actions: List[RankedAction]
    probe_id: str
    inference_ms: float

class PredictRequest(BaseModel):
    state_embedding: List[float]
    action_embedding: List[float]

class PredictResponse(BaseModel):
    predicted_embedding: List[float]
    dim: int
    inference_ms: float

class TreeSearchRequest(BaseModel):
    state_embedding: List[float]
    goal_embedding: List[float]
    action_embeddings: List[List[float]]
    action_labels: List[str]
    depth: int = 3
    width: int = 5
    probe_id: str = "planning-v2"

class TreeSearchStep(BaseModel):
    action: str
    score: float
    goal_proximity: float

class TreeSearchResponse(BaseModel):
    best_path: List[TreeSearchStep]
    best_terminal_proximity: float
    paths_evaluated: int
    search_ms: float

class GoalProximityRequest(BaseModel):
    state_embedding: List[float]
    goal_embedding: List[float]

class GoalProximityResponse(BaseModel):
    proximity: float
    inference_ms: float

class DetectFailureRequest(BaseModel):
    state_embedding: List[float]
    previous_state_embedding: Optional[List[float]] = None
    action_taken: Optional[str] = None

class DetectFailureResponse(BaseModel):
    is_failure: bool
    confidence: float
    failure_type: Optional[str] = None
    inference_ms: float

class HealthResponse(BaseModel):
    status: str
    model_loaded: bool
    model_version: str
    device: str
    uptime_seconds: float

class ReloadRequest(BaseModel):
    checkpoint_path: Optional[str] = None

class ReloadResponse(BaseModel):
    success: bool
    model_version: str
    reload_ms: float

# ---------------------------------------------------------------------------
# Application State
# ---------------------------------------------------------------------------

class SidecarState:
    """Holds the loaded StratusBrain and metadata."""

    def __init__(self):
        self.brain = None
        self.model_version: str = "not_loaded"
        self.device: str = "cpu"
        self.start_time: float = time.time()
        self.checkpoint_path: Optional[str] = None

    def load_brain(self, checkpoint_path: Optional[str] = None):
        """Load or reload the StratusBrain from checkpoint."""
        import sys

        # Add m-jepa-g to path for importing StratusBrain
        jepa_path = os.environ.get(
            "STRATUS_MODEL_PATH",
            os.path.join(os.path.dirname(__file__), "..", "..", "m-jepa-g"),
        )
        if jepa_path not in sys.path:
            sys.path.insert(0, jepa_path)

        path = checkpoint_path or self.checkpoint_path or os.environ.get(
            "STRATUS_CHECKPOINT",
            "/mnt/nvme1/v6_checkpoints/best_checkpoint.pt",
        )

        self.device = "cuda" if torch.cuda.is_available() else "cpu"

        try:
            from api.core.stratus_brain import StratusBrain
            self.brain = StratusBrain(path, device=self.device)
            self.model_version = f"v6-{os.path.basename(path)}"
            self.checkpoint_path = path
            logger.info(f"StratusBrain loaded from {path} on {self.device}")
        except Exception as e:
            logger.error(f"Failed to load StratusBrain: {e}")
            # Create a stub brain for development/testing
            self.brain = None
            self.model_version = "stub"
            logger.warning("Running in stub mode — no real model loaded")

state = SidecarState()

# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load model on startup, cleanup on shutdown."""
    logger.info("Stratus Sidecar starting...")
    state.load_brain()
    yield
    logger.info("Stratus Sidecar shutting down...")

# ---------------------------------------------------------------------------
# FastAPI App
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Stratus Sidecar",
    description="RPC bridge between TypeScript harness and Stratus world model",
    version="0.1.0",
    lifespan=lifespan,
)

# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health", response_model=HealthResponse)
async def health():
    return HealthResponse(
        status="ok" if state.brain is not None else "stub",
        model_loaded=state.brain is not None,
        model_version=state.model_version,
        device=state.device,
        uptime_seconds=time.time() - state.start_time,
    )

@app.post("/encode_state", response_model=EncodeStateResponse)
async def encode_state(req: EncodeStateRequest):
    start = time.perf_counter()

    if state.brain is None:
        # Stub: return zero embedding
        dim = 1024
        return EncodeStateResponse(
            embedding=[0.0] * dim,
            dim=dim,
            encoding_ms=(time.perf_counter() - start) * 1000,
        )

    episode = state.brain.create_episode(goal_text="", state_text=req.text)
    emb = episode.current_state_emb.squeeze(0).tolist()

    return EncodeStateResponse(
        embedding=emb,
        dim=len(emb),
        encoding_ms=(time.perf_counter() - start) * 1000,
    )

@app.post("/encode_goal", response_model=EncodeGoalResponse)
async def encode_goal(req: EncodeGoalRequest):
    start = time.perf_counter()

    if state.brain is None:
        dim = 1024
        return EncodeGoalResponse(
            embedding=[0.0] * dim,
            dim=dim,
            encoding_ms=(time.perf_counter() - start) * 1000,
        )

    episode = state.brain.create_episode(goal_text=req.text, state_text="")
    emb = episode.goal_emb.squeeze(0).tolist()

    return EncodeGoalResponse(
        embedding=emb,
        dim=len(emb),
        encoding_ms=(time.perf_counter() - start) * 1000,
    )

@app.post("/encode_actions", response_model=EncodeActionsResponse)
async def encode_actions(req: EncodeActionsRequest):
    start = time.perf_counter()

    if state.brain is None:
        dim = 1024
        return EncodeActionsResponse(
            embeddings=[
                ActionEmbedding(text=t, embedding=[0.0] * dim)
                for t in req.texts
            ],
            dim=dim,
            count=len(req.texts),
            encoding_ms=(time.perf_counter() - start) * 1000,
        )

    # Use the action encoder directly
    device = torch.device(state.device)
    embs = state.brain.action_encoder.encode_texts(req.texts, device)

    result = []
    for i, text in enumerate(req.texts):
        result.append(ActionEmbedding(
            text=text,
            embedding=embs[i].tolist(),
        ))

    return EncodeActionsResponse(
        embeddings=result,
        dim=embs.shape[1],
        count=len(req.texts),
        encoding_ms=(time.perf_counter() - start) * 1000,
    )

@app.post("/probe_rank", response_model=ProbeRankResponse)
async def probe_rank(req: ProbeRankRequest):
    start = time.perf_counter()

    if state.brain is None:
        # Stub: return actions in order with decreasing scores
        ranked = [
            RankedAction(action=a, score=1.0 - i * 0.1, rank=i + 1)
            for i, a in enumerate(req.action_labels[:req.top_k])
        ]
        return ProbeRankResponse(
            ranked_actions=ranked,
            probe_id=req.probe_id,
            inference_ms=(time.perf_counter() - start) * 1000,
        )

    device = torch.device(state.device)
    state_emb = torch.tensor([req.state_embedding], device=device)
    goal_emb = torch.tensor([req.goal_embedding], device=device)
    action_embs = torch.tensor(req.action_embeddings, device=device)

    # Use policy probe to rank
    import torch.nn.functional as F
    query = state.brain.probe_forward(state_emb, goal_emb)
    scores = F.cosine_similarity(
        query.unsqueeze(1),
        action_embs.unsqueeze(0),
        dim=-1,
    ).squeeze(0)

    top_k = min(req.top_k, len(req.action_labels))
    top_scores, top_indices = scores.topk(top_k)

    ranked = []
    for rank, (idx, score) in enumerate(zip(top_indices.tolist(), top_scores.tolist())):
        ranked.append(RankedAction(
            action=req.action_labels[idx],
            score=score,
            rank=rank + 1,
        ))

    return ProbeRankResponse(
        ranked_actions=ranked,
        probe_id=req.probe_id,
        inference_ms=(time.perf_counter() - start) * 1000,
    )

@app.post("/predict", response_model=PredictResponse)
async def predict(req: PredictRequest):
    start = time.perf_counter()

    if state.brain is None:
        dim = len(req.state_embedding)
        return PredictResponse(
            predicted_embedding=[0.0] * dim,
            dim=dim,
            inference_ms=(time.perf_counter() - start) * 1000,
        )

    device = torch.device(state.device)
    state_emb = torch.tensor([req.state_embedding], device=device)
    action_emb = torch.tensor([req.action_embedding], device=device)

    predicted = state.brain.predict(state_emb, action_emb)
    emb = predicted.squeeze(0).tolist()

    return PredictResponse(
        predicted_embedding=emb,
        dim=len(emb),
        inference_ms=(time.perf_counter() - start) * 1000,
    )

@app.post("/tree_search", response_model=TreeSearchResponse)
async def tree_search(req: TreeSearchRequest):
    start = time.perf_counter()

    if state.brain is None:
        # Stub: return first action as best path
        return TreeSearchResponse(
            best_path=[TreeSearchStep(
                action=req.action_labels[0] if req.action_labels else "none",
                score=0.5,
                goal_proximity=0.5,
            )],
            best_terminal_proximity=0.5,
            paths_evaluated=1,
            search_ms=(time.perf_counter() - start) * 1000,
        )

    device = torch.device(state.device)
    state_emb = torch.tensor([req.state_embedding], device=device)
    goal_emb = torch.tensor([req.goal_embedding], device=device)
    action_embs = torch.tensor(req.action_embeddings, device=device)

    import torch.nn.functional as F

    best_path = []
    best_terminal = 0.0
    paths_evaluated = 0
    current = state_emb

    for depth in range(req.depth):
        # Rank actions from current state
        query = state.brain.probe_forward(current, goal_emb)
        scores = F.cosine_similarity(
            query.unsqueeze(1),
            action_embs.unsqueeze(0),
            dim=-1,
        ).squeeze(0)

        top_k = min(req.width, len(req.action_labels))
        top_scores, top_indices = scores.topk(top_k)

        # Take best action
        best_idx = top_indices[0].item()
        best_score = top_scores[0].item()

        # Predict next state
        predicted = state.brain.predict(current, action_embs[best_idx].unsqueeze(0))
        proximity = F.cosine_similarity(predicted, goal_emb).item()

        best_path.append(TreeSearchStep(
            action=req.action_labels[best_idx],
            score=best_score,
            goal_proximity=proximity,
        ))

        current = predicted
        best_terminal = proximity
        paths_evaluated += top_k

    return TreeSearchResponse(
        best_path=best_path,
        best_terminal_proximity=best_terminal,
        paths_evaluated=paths_evaluated,
        search_ms=(time.perf_counter() - start) * 1000,
    )

@app.post("/goal_proximity", response_model=GoalProximityResponse)
async def goal_proximity(req: GoalProximityRequest):
    start = time.perf_counter()

    import torch.nn.functional as F
    state_emb = torch.tensor([req.state_embedding])
    goal_emb = torch.tensor([req.goal_embedding])
    proximity = F.cosine_similarity(state_emb, goal_emb).item()

    return GoalProximityResponse(
        proximity=proximity,
        inference_ms=(time.perf_counter() - start) * 1000,
    )

@app.post("/detect_failure", response_model=DetectFailureResponse)
async def detect_failure(req: DetectFailureRequest):
    start = time.perf_counter()

    is_failure = False
    confidence = 0.0
    failure_type = None

    if req.previous_state_embedding:
        import torch.nn.functional as F
        current = torch.tensor([req.state_embedding])
        previous = torch.tensor([req.previous_state_embedding])

        # Detect stuck state (no progress)
        similarity = F.cosine_similarity(current, previous).item()
        if similarity > 0.99:
            is_failure = True
            confidence = similarity
            failure_type = "stuck"

    return DetectFailureResponse(
        is_failure=is_failure,
        confidence=confidence,
        failure_type=failure_type,
        inference_ms=(time.perf_counter() - start) * 1000,
    )

@app.post("/reload", response_model=ReloadResponse)
async def reload(req: ReloadRequest):
    start = time.perf_counter()
    state.load_brain(req.checkpoint_path)
    return ReloadResponse(
        success=state.brain is not None,
        model_version=state.model_version,
        reload_ms=(time.perf_counter() - start) * 1000,
    )

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.environ.get("STRATUS_SIDECAR_PORT", "8100"))
    host = os.environ.get("STRATUS_SIDECAR_HOST", "127.0.0.1")

    uvicorn.run(
        "server:app",
        host=host,
        port=port,
        log_level="info",
        reload=os.environ.get("STRATUS_DEV", "0") == "1",
    )
