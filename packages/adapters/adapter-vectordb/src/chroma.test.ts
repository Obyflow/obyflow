import { describe, it, expect, vi } from "vitest";
import { instrumentChromaCollection } from "./chroma.js";
import type { InstrumentationContext } from "./types.js";

describe("instrumentChromaCollection", () => {
  it("converts Chroma distances into similarity scores", async () => {
    const emit = vi.fn();
    const ctx: InstrumentationContext = { service: "svc", emit };

    const collection = {
      query: vi.fn().mockResolvedValue({
        ids: [["doc-1", "doc-2", "doc-3"]],
        distances: [[0, 1, 3]],
      }),
    };

    const instrumented = instrumentChromaCollection(collection, ctx);

    const result = await instrumented.query({
      nResults: 3,
      where: { category: "test" },
    });

    expect(result).toEqual({
      ids: [["doc-1", "doc-2", "doc-3"]],
      distances: [[0, 1, 3]],
    });

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "vector_op",
        attributes: expect.objectContaining({
          operation: "query",
          db_provider: "chroma",
          top_k: 3,
          result_count: 3,
          similarity_scores: [1, 0.5, 0.25],
        }),
      }),
    );
  });
});