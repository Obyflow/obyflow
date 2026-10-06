from __future__ import annotations

from obyflow.client import SqliteStore
from obyflow.context import TraceContext, reset_trace_context, set_trace_context
from obyflow.instrumentation.vectordb import (
    VectorDbInstrumentationContext,
    instrument_chroma_collection,
    instrument_openai_embeddings_client,
    instrument_pinecone_index,
)


class FakeMatch:
    def __init__(self, score: float):
        self.score = score


class FakeQueryResult:
    def __init__(self, matches):
        self.matches = matches


class FakePineconeIndex:
    def query(self, **kwargs):
        return FakeQueryResult([FakeMatch(0.9), FakeMatch(0.5)])


def test_instrument_pinecone_index_emits_vector_op(tmp_path):
    store = SqliteStore(tmp_path / "obyflow.db")
    ctx = VectorDbInstrumentationContext(service="svc", store=store)
    index = instrument_pinecone_index(FakePineconeIndex(), ctx, collection="docs")

    token = set_trace_context(TraceContext(trace_id="trace-1", request_id="req-1"))
    try:
        index.query(top_k=2)
    finally:
        reset_trace_context(token)

    rows = store.get_by_trace_id("trace-1")
    assert len(rows) == 1
    assert rows[0].type == "vector_op"
    assert rows[0].attributes["db_provider"] == "pinecone"
    assert rows[0].attributes["result_count"] == 2


class FakeChromaCollection:
    name = "docs"

    def query(self, **kwargs):
        return {
            "ids": [["doc-1", "doc-2", "doc-3"]],
            "distances": [[0, 1, 3]],
        }


def test_instrument_chroma_collection_converts_distances_to_similarity_scores(tmp_path):
    store = SqliteStore(tmp_path / "obyflow.db")
    ctx = VectorDbInstrumentationContext(service="svc", store=store)
    collection = instrument_chroma_collection(FakeChromaCollection(), ctx)

    token = set_trace_context(TraceContext(trace_id="trace-chroma", request_id="req-chroma"))
    try:
        collection.query(n_results=3, where={"category": "test"})
    finally:
        reset_trace_context(token)

    rows = store.get_by_trace_id("trace-chroma")
    assert len(rows) == 1
    assert rows[0].type == "vector_op"
    assert rows[0].attributes["db_provider"] == "chroma"
    assert rows[0].attributes["result_count"] == 3
    assert rows[0].attributes["similarity_scores"] == [1.0, 0.5, 0.25]

class FakeEmbeddingItem:
    def __init__(self, embedding):
        self.embedding = embedding


class FakeUsage:
    def __init__(self, prompt_tokens):
        self.prompt_tokens = prompt_tokens


class FakeEmbeddingResponse:
    def __init__(self, data, usage):
        self.data = data
        self.usage = usage


class FakeEmbeddings:
    def create(self, **kwargs):
        return FakeEmbeddingResponse([FakeEmbeddingItem([0.1, 0.2, 0.3])], FakeUsage(5))


class FakeOpenAIClient:
    def __init__(self):
        self.embeddings = FakeEmbeddings()


def test_instrument_openai_embeddings_client_emits_embedding(tmp_path):
    store = SqliteStore(tmp_path / "obyflow.db")
    ctx = VectorDbInstrumentationContext(service="svc", store=store)
    client = instrument_openai_embeddings_client(FakeOpenAIClient(), ctx)

    token = set_trace_context(TraceContext(trace_id="trace-2", request_id="req-2"))
    try:
        client.embeddings.create(model="text-embedding-3-small", input="hello")
    finally:
        reset_trace_context(token)

    rows = store.get_by_trace_id("trace-2")
    assert len(rows) == 1
    assert rows[0].type == "embedding"
    assert rows[0].attributes["provider"] == "openai"
    assert rows[0].attributes["dimensions"] == 3
