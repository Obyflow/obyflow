from __future__ import annotations

import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from ..client import SqliteStore
from ..context import get_active_request_id, get_active_span_id, get_active_trace_id
from ..events import validate_event
from ..resource_attributes import ResourceAttributesInput, resolve_resource_attributes


class VectorDbInstrumentationContext:
    def __init__(
        self,
        service: str,
        store: SqliteStore,
        deployment_id: Optional[str] = None,
        resource_attributes: Optional[ResourceAttributesInput] = None,
    ):
        self.service = service
        self.store = store
        self.deployment_id = deployment_id
        self.resource_attributes = resource_attributes

    def emit(
        self, event_type: str, attributes: Dict[str, Any], duration_ms: Optional[float]
    ) -> None:
        candidate = {
            "id": str(uuid.uuid4()),
            "type": event_type,
            "trace_id": get_active_trace_id(),
            "span_id": str(uuid.uuid4()),
            "parent_span_id": get_active_span_id(),
            "request_id": get_active_request_id(),
            "service": self.service,
            "host": None,
            "container": None,
            "deployment_id": self.deployment_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "duration_ms": duration_ms,
            "attributes": attributes,
            "resource_attributes": resolve_resource_attributes(self.resource_attributes),
            "severity": None,
        }
        event = validate_event(candidate)
        try:
            self.store.insert(event)
        except Exception as exc:
            self.store.record_telemetry_failure(
                operation="vectordb.insert",
                service=self.service,
                reason=str(exc),
            )


def _emit_vector_op(
    ctx: VectorDbInstrumentationContext,
    provider: str,
    operation: str,
    collection: Optional[str],
    top_k: Optional[int],
    filter_: Optional[Dict[str, Any]],
    result_count: Optional[int],
    similarity_scores: Optional[List[float]],
    latency_ms: float,
) -> None:
    ctx.emit(
        "vector_op",
        {
            "operation": operation,
            "db_provider": provider,
            "collection": collection,
            "top_k": top_k,
            "filter": filter_,
            "result_count": result_count,
            "similarity_scores": similarity_scores,
            "latency_ms": latency_ms,
        },
        latency_ms,
    )


def _emit_embedding(
    ctx: VectorDbInstrumentationContext,
    provider: str,
    model: str,
    input_tokens: Optional[int],
    dimensions: Optional[int],
    batch_size: Optional[int],
    latency_ms: float,
) -> None:
    ctx.emit(
        "embedding",
        {
            "model": model,
            "input_tokens": input_tokens,
            "dimensions": dimensions,
            "provider": provider,
            "latency_ms": latency_ms,
            "batch_size": batch_size,
        },
        latency_ms,
    )


def instrument_pinecone_index(
    index: Any, ctx: VectorDbInstrumentationContext, collection: Optional[str] = None
) -> Any:
    if hasattr(index, "query"):
        original_query = index.query

        def wrapped_query(*args: Any, **kwargs: Any) -> Any:
            started_at = time.monotonic()
            result = original_query(*args, **kwargs)
            latency_ms = (time.monotonic() - started_at) * 1000
            matches = getattr(result, "matches", None) or (
                result.get("matches") if isinstance(result, dict) else []
            )
            scores = (
                [m.score if hasattr(m, "score") else m.get("score") for m in matches]
                if matches
                else []
            )
            scores = [s for s in scores if isinstance(s, (int, float))]
            _emit_vector_op(
                ctx,
                "pinecone",
                "query",
                collection,
                kwargs.get("top_k"),
                kwargs.get("filter"),
                len(matches) if matches else None,
                scores or None,
                latency_ms,
            )
            return result

        index.query = wrapped_query

    if hasattr(index, "upsert"):
        original_upsert = index.upsert

        def wrapped_upsert(*args: Any, **kwargs: Any) -> Any:
            started_at = time.monotonic()
            result = original_upsert(*args, **kwargs)
            latency_ms = (time.monotonic() - started_at) * 1000
            vectors = kwargs.get("vectors") or (args[0] if args else None)
            count = len(vectors) if isinstance(vectors, list) else None
            _emit_vector_op(
                ctx,
                "pinecone",
                "upsert",
                collection,
                None,
                None,
                count,
                None,
                latency_ms,
            )
            return result

        index.upsert = wrapped_upsert

    if hasattr(index, "delete"):
        original_delete = index.delete

        def wrapped_delete(*args: Any, **kwargs: Any) -> Any:
            started_at = time.monotonic()
            result = original_delete(*args, **kwargs)
            latency_ms = (time.monotonic() - started_at) * 1000
            _emit_vector_op(
                ctx,
                "pinecone",
                "delete",
                collection,
                None,
                None,
                None,
                None,
                latency_ms,
            )
            return result

        index.delete = wrapped_delete

    return index


def instrument_qdrant_client(client: Any, ctx: VectorDbInstrumentationContext) -> Any:
    if hasattr(client, "search"):
        original_search = client.search

        def wrapped_search(collection_name: str, *args: Any, **kwargs: Any) -> Any:
            started_at = time.monotonic()
            result = original_search(collection_name, *args, **kwargs)
            latency_ms = (time.monotonic() - started_at) * 1000
            points = (
                result if isinstance(result, list) else getattr(result, "result", [])
            )
            scores = [
                getattr(p, "score", None) if not isinstance(p, dict) else p.get("score")
                for p in points
            ]
            scores = [s for s in scores if isinstance(s, (int, float))]
            _emit_vector_op(
                ctx,
                "qdrant",
                "query",
                collection_name,
                kwargs.get("limit"),
                kwargs.get("query_filter") or kwargs.get("filter"),
                len(points) if points else None,
                scores or None,
                latency_ms,
            )
            return result

        client.search = wrapped_search

    if hasattr(client, "upsert"):
        original_upsert = client.upsert

        def wrapped_upsert(collection_name: str, *args: Any, **kwargs: Any) -> Any:
            started_at = time.monotonic()
            result = original_upsert(collection_name, *args, **kwargs)
            latency_ms = (time.monotonic() - started_at) * 1000
            points = kwargs.get("points")
            count = len(points) if isinstance(points, list) else None
            _emit_vector_op(
                ctx,
                "qdrant",
                "upsert",
                collection_name,
                None,
                None,
                count,
                None,
                latency_ms,
            )
            return result

        client.upsert = wrapped_upsert

    if hasattr(client, "delete"):
        original_delete = client.delete

        def wrapped_delete(collection_name: str, *args: Any, **kwargs: Any) -> Any:
            started_at = time.monotonic()
            result = original_delete(collection_name, *args, **kwargs)
            latency_ms = (time.monotonic() - started_at) * 1000
            _emit_vector_op(
                ctx,
                "qdrant",
                "delete",
                collection_name,
                None,
                None,
                None,
                None,
                latency_ms,
            )
            return result

        client.delete = wrapped_delete

    return client


def instrument_chroma_collection(
    collection: Any,
    ctx: VectorDbInstrumentationContext,
    collection_name: Optional[str] = None,
) -> Any:
    if hasattr(collection, "query"):
        original_query = collection.query

        def wrapped_query(*args: Any, **kwargs: Any) -> Any:
            started_at = time.monotonic()
            result = original_query(*args, **kwargs)
            latency_ms = (time.monotonic() - started_at) * 1000
            ids = (result.get("ids") or [[]])[0] if isinstance(result, dict) else []
            distances = (
                (result.get("distances") or [[]])[0] if isinstance(result, dict) else []
            )
            _emit_vector_op(
                ctx,
                "chroma",
                "query",
                collection_name or getattr(collection, "name", None),
                kwargs.get("n_results"),
                kwargs.get("where"),
                len(ids) if ids else None,
                [1 / (1 + d) for d in distances if isinstance(d, (int, float))] or None,
                latency_ms,
            )
            return result

        collection.query = wrapped_query

    if hasattr(collection, "add"):
        original_add = collection.add

        def wrapped_add(*args: Any, **kwargs: Any) -> Any:
            started_at = time.monotonic()
            result = original_add(*args, **kwargs)
            latency_ms = (time.monotonic() - started_at) * 1000
            ids = kwargs.get("ids")
            count = len(ids) if isinstance(ids, list) else None
            _emit_vector_op(
                ctx,
                "chroma",
                "upsert",
                collection_name or getattr(collection, "name", None),
                None,
                None,
                count,
                None,
                latency_ms,
            )
            return result

        collection.add = wrapped_add

    if hasattr(collection, "delete"):
        original_delete = collection.delete

        def wrapped_delete(*args: Any, **kwargs: Any) -> Any:
            started_at = time.monotonic()
            result = original_delete(*args, **kwargs)
            latency_ms = (time.monotonic() - started_at) * 1000
            _emit_vector_op(
                ctx,
                "chroma",
                "delete",
                collection_name or getattr(collection, "name", None),
                None,
                None,
                None,
                None,
                latency_ms,
            )
            return result

        collection.delete = wrapped_delete

    return collection


_PGVECTOR_OPERATOR_PATTERN = re.compile(r"<->|<=>|<#>|vector", re.IGNORECASE)
_TABLE_NAME_PATTERN = re.compile(
    r"(?:FROM|INTO|UPDATE)\s+([a-zA-Z0-9_.\"]+)", re.IGNORECASE
)


def _classify_pg_operation(sql: str) -> str:
    normalized = sql.strip().upper()
    if normalized.startswith("INSERT"):
        return "upsert"
    if normalized.startswith("DELETE"):
        return "delete"
    return "query"


def _extract_table_name(sql: str) -> Optional[str]:
    match = _TABLE_NAME_PATTERN.search(sql)
    return match.group(1) if match else None


def instrument_pgvector_cursor(cursor: Any, ctx: VectorDbInstrumentationContext) -> Any:
    original_execute = cursor.execute

    def wrapped_execute(
        query: str, params: Optional[Any] = None, *args: Any, **kwargs: Any
    ) -> Any:
        started_at = time.monotonic()
        result = (
            original_execute(query, params, *args, **kwargs)
            if params is not None
            else original_execute(query, *args, **kwargs)
        )
        latency_ms = (time.monotonic() - started_at) * 1000
        if not _PGVECTOR_OPERATOR_PATTERN.search(query):
            return result
        rows: List[Any] = []
        try:
            rows = cursor.fetchall()
        except Exception:
            rows = []
        similarity_scores = None
        if rows and isinstance(rows[0], dict):
            key = next(
                (
                    k
                    for k in rows[0].keys()
                    if k.lower() in ("distance", "similarity", "score")
                ),
                None,
            )
            if key:
                similarity_scores = [
                    r[key] for r in rows if isinstance(r.get(key), (int, float))
                ] or None
        _emit_vector_op(
            ctx,
            "pgvector",
            _classify_pg_operation(query),
            _extract_table_name(query),
            None,
            None,
            len(rows) if rows else None,
            similarity_scores,
            latency_ms,
        )
        return result

    cursor.execute = wrapped_execute
    return cursor


def instrument_milvus_client(client: Any, ctx: VectorDbInstrumentationContext) -> Any:
    if hasattr(client, "search"):
        original_search = client.search

        def wrapped_search(*args: Any, **kwargs: Any) -> Any:
            started_at = time.monotonic()
            result = original_search(*args, **kwargs)
            latency_ms = (time.monotonic() - started_at) * 1000
            hits = result if isinstance(result, list) else []
            scores = [
                h.get("score") if isinstance(h, dict) else getattr(h, "score", None)
                for h in hits
            ]
            scores = [s for s in scores if isinstance(s, (int, float))]
            _emit_vector_op(
                ctx,
                "milvus",
                "query",
                kwargs.get("collection_name"),
                kwargs.get("limit"),
                kwargs.get("filter"),
                len(hits) if hits else None,
                scores or None,
                latency_ms,
            )
            return result

        client.search = wrapped_search

    if hasattr(client, "insert"):
        original_insert = client.insert

        def wrapped_insert(*args: Any, **kwargs: Any) -> Any:
            started_at = time.monotonic()
            result = original_insert(*args, **kwargs)
            latency_ms = (time.monotonic() - started_at) * 1000
            data = kwargs.get("data") or kwargs.get("fields_data")
            count = len(data) if isinstance(data, list) else None
            _emit_vector_op(
                ctx,
                "milvus",
                "upsert",
                kwargs.get("collection_name"),
                None,
                None,
                count,
                None,
                latency_ms,
            )
            return result

        client.insert = wrapped_insert

    if hasattr(client, "delete"):
        original_delete = client.delete

        def wrapped_delete(*args: Any, **kwargs: Any) -> Any:
            started_at = time.monotonic()
            result = original_delete(*args, **kwargs)
            latency_ms = (time.monotonic() - started_at) * 1000
            _emit_vector_op(
                ctx,
                "milvus",
                "delete",
                kwargs.get("collection_name"),
                None,
                None,
                None,
                None,
                latency_ms,
            )
            return result

        client.delete = wrapped_delete

    return client


def instrument_weaviate_client(client: Any, ctx: VectorDbInstrumentationContext) -> Any:
    if hasattr(client, "query"):
        original_query = client.query

        def wrapped_query(params: Dict[str, Any], *args: Any, **kwargs: Any) -> Any:
            started_at = time.monotonic()
            result = original_query(params, *args, **kwargs)
            latency_ms = (time.monotonic() - started_at) * 1000
            data = (
                result.get("data", {}).get("Get", {})
                if isinstance(result, dict)
                else {}
            )
            items: List[Any] = []
            for value in data.values():
                if isinstance(value, list):
                    items.extend(value)
            if not items and isinstance(result, dict):
                items = result.get("objects", []) or []
            scores: List[float] = []
            for item in items:
                additional = item.get("_additional", {}) if isinstance(item, dict) else {}
                score = additional.get("certainty", additional.get("distance"))
                if isinstance(score, (int, float)):
                    scores.append(score)
            _emit_vector_op(
                ctx,
                "weaviate",
                "query",
                params.get("className") if isinstance(params, dict) else None,
                params.get("limit") if isinstance(params, dict) else None,
                params.get("where") if isinstance(params, dict) else None,
                len(items) if items else None,
                scores or None,
                latency_ms,
            )
            return result

        client.query = wrapped_query

    if hasattr(client, "upsert"):
        original_upsert = client.upsert

        def wrapped_upsert(params: Dict[str, Any], *args: Any, **kwargs: Any) -> Any:
            started_at = time.monotonic()
            result = original_upsert(params, *args, **kwargs)
            latency_ms = (time.monotonic() - started_at) * 1000
            objects = params.get("objects") if isinstance(params, dict) else None
            count = len(objects) if isinstance(objects, list) else None
            _emit_vector_op(
                ctx,
                "weaviate",
                "upsert",
                params.get("className") if isinstance(params, dict) else None,
                None,
                None,
                count,
                None,
                latency_ms,
            )
            return result

        client.upsert = wrapped_upsert

    if hasattr(client, "delete"):
        original_delete = client.delete

        def wrapped_delete(params: Dict[str, Any], *args: Any, **kwargs: Any) -> Any:
            started_at = time.monotonic()
            result = original_delete(params, *args, **kwargs)
            latency_ms = (time.monotonic() - started_at) * 1000
            _emit_vector_op(
                ctx,
                "weaviate",
                "delete",
                params.get("className") if isinstance(params, dict) else None,
                None,
                None,
                None,
                None,
                latency_ms,
            )
            return result

        client.delete = wrapped_delete

    return client


def instrument_openai_embeddings_client(
    client: Any, ctx: VectorDbInstrumentationContext
) -> Any:
    original_create = client.embeddings.create

    def wrapped_create(*args: Any, **kwargs: Any) -> Any:
        started_at = time.monotonic()
        result = original_create(*args, **kwargs)
        latency_ms = (time.monotonic() - started_at) * 1000
        usage = getattr(result, "usage", None)
        input_tokens = getattr(usage, "prompt_tokens", None) if usage else None
        data = getattr(result, "data", None)
        dimensions = (
            len(data[0].embedding) if data and hasattr(data[0], "embedding") else None
        )
        input_value = kwargs.get("input")
        batch_size = len(input_value) if isinstance(input_value, list) else 1
        _emit_embedding(
            ctx,
            "openai",
            kwargs.get("model", "unknown"),
            input_tokens,
            dimensions,
            batch_size,
            latency_ms,
        )
        return result

    client.embeddings.create = wrapped_create
    return client


def instrument_anthropic_embeddings_client(
    client: Any, ctx: VectorDbInstrumentationContext
) -> Any:
    original_create = client.embeddings.create

    def wrapped_create(*args: Any, **kwargs: Any) -> Any:
        started_at = time.monotonic()
        result = original_create(*args, **kwargs)
        latency_ms = (time.monotonic() - started_at) * 1000
        usage = getattr(result, "usage", None)
        input_tokens = getattr(usage, "input_tokens", None) if usage else None
        embedding = getattr(result, "embedding", None)
        dimensions = len(embedding) if isinstance(embedding, list) else None
        input_value = kwargs.get("input")
        batch_size = len(input_value) if isinstance(input_value, list) else 1
        _emit_embedding(
            ctx,
            "anthropic",
            kwargs.get("model", "unknown"),
            input_tokens,
            dimensions,
            batch_size,
            latency_ms,
        )
        return result

    client.embeddings.create = wrapped_create
    return client


def instrument_cohere_embeddings_client(
    client: Any, ctx: VectorDbInstrumentationContext
) -> Any:
    original_embed = client.embed

    def wrapped_embed(*args: Any, **kwargs: Any) -> Any:
        started_at = time.monotonic()
        result = original_embed(*args, **kwargs)
        latency_ms = (time.monotonic() - started_at) * 1000
        embeddings = getattr(result, "embeddings", None)
        dimensions = len(embeddings[0]) if embeddings else None
        texts = kwargs.get("texts")
        batch_size = len(texts) if isinstance(texts, list) else 1
        _emit_embedding(
            ctx,
            "cohere",
            kwargs.get("model", "unknown"),
            None,
            dimensions,
            batch_size,
            latency_ms,
        )
        return result

    client.embed = wrapped_embed
    return client
