from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

EventType = Literal[
    "trace",
    "log",
    "metric",
    "error",
    "embedding",
    "vector_op",
    "chain",
    "tool_call",
    "llm_call",
    "custom",
]

Severity = Literal["debug", "info", "warn", "error", "critical"]


class EmbeddingAttributes(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: str
    input_tokens: Optional[int] = None
    dimensions: Optional[int] = None
    provider: str
    latency_ms: Optional[float] = None
    batch_size: Optional[int] = None


class VectorOpAttributes(BaseModel):
    model_config = ConfigDict(extra="allow")
    operation: Literal["query", "upsert", "delete"]
    db_provider: Literal[
        "pinecone", "qdrant", "weaviate", "chroma", "pgvector", "milvus", "custom"
    ]
    collection: Optional[str] = None
    top_k: Optional[int] = None
    filter: Optional[Dict[str, Any]] = None
    result_count: Optional[int] = None
    similarity_scores: Optional[List[float]] = None
    latency_ms: Optional[float] = None


class ChainAttributes(BaseModel):
    model_config = ConfigDict(extra="allow")
    framework: Literal["langchain", "langgraph", "llamaindex", "custom"]
    chain_name: Optional[str] = None
    graph_node: Optional[str] = None
    run_id: str
    parent_run_id: Optional[str] = None
    input_preview: Optional[str] = None
    output_preview: Optional[str] = None
    status: Literal["success", "error"]


class ToolCallAttributes(BaseModel):
    model_config = ConfigDict(extra="allow")
    tool_name: str
    args_preview: Optional[str] = None
    result_preview: Optional[str] = None
    status: Literal["success", "error"]


class LlmCallAttributes(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: str
    provider: str
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None
    latency_ms: Optional[float] = None
    stop_reason: Optional[str] = None


_ATTRIBUTE_SCHEMA_BY_TYPE = {
    "embedding": EmbeddingAttributes,
    "vector_op": VectorOpAttributes,
    "chain": ChainAttributes,
    "tool_call": ToolCallAttributes,
    "llm_call": LlmCallAttributes,
}


class Event(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    type: EventType
    trace_id: Optional[str] = None
    span_id: Optional[str] = None
    parent_span_id: Optional[str] = None
    request_id: Optional[str] = None
    service: str
    host: Optional[str] = None
    container: Optional[str] = None
    deployment_id: Optional[str] = None
    timestamp: str
    duration_ms: Optional[float] = None
    attributes: Dict[str, Any] = Field(default_factory=dict)
    resource_attributes: Optional[Dict[str, Any]] = None
    severity: Optional[Severity] = None

    @field_validator("timestamp")
    @classmethod
    def _timestamp_is_iso8601(cls, value: str) -> str:
        candidate = value.replace("Z", "+00:00")
        try:
            datetime.fromisoformat(candidate)
        except ValueError as exc:
            raise ValueError(
                f"timestamp must be a valid ISO8601 datetime string, got {value!r}"
            ) from exc
        return value

    @field_validator("duration_ms")
    @classmethod
    def _duration_non_negative(cls, value: Optional[float]) -> Optional[float]:
        if value is not None and value < 0:
            raise ValueError("duration_ms must be non-negative")
        return value


class EventValidationError(Exception):
    def __init__(self, message: str, issues: Optional[List[Any]] = None):
        super().__init__(message)
        self.message = message
        self.issues = issues or []


def validate_event(raw: Union[Dict[str, Any], Event]) -> Event:

    if isinstance(raw, Event):
        raw = raw.model_dump()

    try:
        event = Event.model_validate(raw)
    except ValidationError as exc:
        raise EventValidationError(
            "Event failed envelope validation", exc.errors()
        ) from exc

    attr_schema = _ATTRIBUTE_SCHEMA_BY_TYPE.get(event.type)
    if attr_schema is not None:
        try:
            attr_schema.model_validate(event.attributes)
        except ValidationError as exc:
            raise EventValidationError(
                f'Event attributes failed validation for type "{event.type}"',
                exc.errors(),
            ) from exc

    if event.type == "chain" and not event.trace_id:
        raise EventValidationError(
            'Event of type "chain" must carry a trace_id to nest under its parent trace',
            [],
        )

    if event.parent_span_id and not event.trace_id:
        raise EventValidationError(
            "Event with a parent_span_id must also carry a trace_id", []
        )

    if event.span_id and event.parent_span_id and event.span_id == event.parent_span_id:
        raise EventValidationError(
            "Event span_id and parent_span_id must not be equal", []
        )

    return event


def safe_validate_event(raw: Union[Dict[str, Any], Event]) -> Dict[str, Any]:

    try:
        return {"ok": True, "event": validate_event(raw)}
    except EventValidationError as err:
        return {"ok": False, "error": err}
