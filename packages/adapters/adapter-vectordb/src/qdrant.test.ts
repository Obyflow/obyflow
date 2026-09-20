import { describe, it, expect, vi } from "vitest";
import { instrumentQdrantClient } from "./qdrant.js";
import type { InstrumentationContext } from "./types.js";

describe("instrumentQdrantClient", () => {
  it("emits a vector_op event on search", async () => {
    const emit = vi.fn();
    const ctx: InstrumentationContext = { service: "svc", emit };

    const client = {
      search: vi.fn().mockResolvedValue([{ score: 0.95 }, { score: 0.42 }]),
    };

    const instrumented = instrumentQdrantClient(client, ctx);
    const result = await instrumented.search("my-collection", { limit: 2, vector: [1, 2, 3] });

    expect(result).toEqual([{ score: 0.95 }, { score: 0.42 }]);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "vector_op",
        attributes: expect.objectContaining({
          operation: "query",
          db_provider: "qdrant",
          collection: "my-collection",
          top_k: 2,
          result_count: 2,
          similarity_scores: [0.95, 0.42],
        }),
      }),
    );
  });

  it("emits a vector_op event on upsert", async () => {
    const emit = vi.fn();
    const ctx: InstrumentationContext = { service: "svc", emit };

    const client = {
      upsert: vi.fn().mockResolvedValue({ status: "completed" }),
    };

    const instrumented = instrumentQdrantClient(client, ctx);
    const result = await instrumented.upsert("my-collection", {
      points: [{ id: 1 }, { id: 2 }, { id: 3 }],
    });

    expect(result).toEqual({ status: "completed" });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "vector_op",
        attributes: expect.objectContaining({
          operation: "upsert",
          db_provider: "qdrant",
          collection: "my-collection",
          result_count: 3,
        }),
      }),
    );
  });

  it("emits a vector_op event on delete", async () => {
    const emit = vi.fn();
    const ctx: InstrumentationContext = { service: "svc", emit };

    const client = {
      delete: vi.fn().mockResolvedValue({ status: "completed" }),
    };

    const instrumented = instrumentQdrantClient(client, ctx);
    const result = await instrumented.delete("my-collection", {
      filter: { must: [{ key: "category", match: { value: "test" } }] },
    });

    expect(result).toEqual({ status: "completed" });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "vector_op",
        attributes: expect.objectContaining({
          operation: "delete",
          db_provider: "qdrant",
          collection: "my-collection",
        }),
      }),
    );
  });
});
