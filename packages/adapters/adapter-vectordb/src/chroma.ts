import { ChromaCollectionLike, InstrumentationContext } from "./types.js";
import { emitVectorOpEvent, timeAsync } from "./shared.js";

interface ChromaQueryResult {
  ids?: string[][];
  distances?: number[][];
}

export function instrumentChromaCollection<T extends ChromaCollectionLike>(
  collection: T,
  ctx: InstrumentationContext,
  collectionName: string | null = null,
): T {
  if (typeof collection.query === "function") {
    const original = collection.query.bind(collection);
    collection.query = async (params: any) => {
      const { result, latencyMs } = await timeAsync<ChromaQueryResult>(() => original(params));
      const ids = result?.ids?.[0] ?? [];
      const distances = result?.distances?.[0] ?? [];
      emitVectorOpEvent(ctx, "chroma", {
        operation: "query",
        collection: collectionName ?? collection?.name ?? null,
        top_k: params?.nResults ?? null,
        filter: params?.where ?? null,
        result_count: Array.isArray(ids) ? ids.length : null,
        // Map Chroma distances to a monotonic higher-is-better score for retrieval diagnosis.
        // This is not true cosine similarity; with Chroma's default squared L2 distance,
        // a score of 0.5 corresponds to a distance of 1.
        similarity_scores: Array.isArray(distances)
          ? distances
              .filter((distance: any) => typeof distance === "number")
              .map((distance: number) => 1 / (1 + distance))
          : null,
        latency_ms: latencyMs,
      });
      return result;
    };
  }

  if (typeof collection.add === "function") {
    const original = collection.add.bind(collection);
    collection.add = async (params: any) => {
      const { result, latencyMs } = await timeAsync(() => original(params));
      const ids = params?.ids ?? [];
      emitVectorOpEvent(ctx, "chroma", {
        operation: "upsert",
        collection: collectionName ?? collection?.name ?? null,
        result_count: Array.isArray(ids) ? ids.length : null,
        latency_ms: latencyMs,
      });
      return result;
    };
  }

  if (typeof collection.delete === "function") {
    const original = collection.delete.bind(collection);
    collection.delete = async (params: any) => {
      const { result, latencyMs } = await timeAsync(() => original(params));
      emitVectorOpEvent(ctx, "chroma", {
        operation: "delete",
        collection: collectionName ?? collection?.name ?? null,
        latency_ms: latencyMs,
      });
      return result;
    };
  }
  return collection;
}