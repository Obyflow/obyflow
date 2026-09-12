import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteStore, rowToEvent } from "./sqlite-store.js";
import type { Event } from "../event-model/event.schema.js";

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: overrides.id ?? "evt_1",
    type: overrides.type ?? "trace",
    trace_id: overrides.trace_id ?? "trace_1",
    span_id: overrides.span_id ?? null,
    parent_span_id: overrides.parent_span_id ?? null,
    request_id: overrides.request_id ?? "req_1",
    service: overrides.service ?? "checkout-service",
    host: overrides.host ?? "host1",
    container: overrides.container ?? "c1",
    deployment_id: overrides.deployment_id ?? "deploy_1",
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    duration_ms: overrides.duration_ms ?? 100,
    attributes: overrides.attributes ?? { route: "/checkout" },
    severity: overrides.severity ?? "info",
  };
}

describe("SqliteStore", () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("inserts and retrieves an event by trace_id", () => {
    store.insert(makeEvent());
    const rows = store.getByTraceId("trace_1");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("evt_1");
  });

  it("counts events older than a given timestamp", () => {
    store.insert(
      makeEvent({
        id: "old_1",
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    );

    store.insert(
      makeEvent({
        id: "old_2",
        timestamp: "2026-02-01T00:00:00.000Z",
      }),
    );

    store.insert(
      makeEvent({
        id: "new_1",
        timestamp: "2026-03-01T00:00:00.000Z",
      }),
    );

    expect(store.countOlderThan("2026-03-01T00:00:00.000Z")).toBe(2);
  });

  it("round-trips attributes as JSON via rowToEvent", () => {
    store.insert(
      makeEvent({ id: "evt_json", attributes: { nested: { a: 1, b: [1, 2, 3] } } }),
    );
    const [row] = store.getByTraceId("trace_1");
    const event = rowToEvent(row);
    expect(event.attributes).toEqual({ nested: { a: 1, b: [1, 2, 3] } });
  });

  it("returns events for a trace ordered by timestamp ascending", () => {
    const t0 = new Date(Date.now() - 2000).toISOString();
    const t1 = new Date(Date.now() - 1000).toISOString();
    const t2 = new Date().toISOString();

    store.insert(makeEvent({ id: "e2", timestamp: t2 }));
    store.insert(makeEvent({ id: "e0", timestamp: t0 }));
    store.insert(makeEvent({ id: "e1", timestamp: t1 }));

    const rows = store.getByTraceId("trace_1");
    expect(rows.map((r) => r.id)).toEqual(["e0", "e1", "e2"]);
  });

  it("isolates events across different trace_ids", () => {
    store.insert(makeEvent({ id: "a1", trace_id: "trace_a" }));
    store.insert(makeEvent({ id: "b1", trace_id: "trace_b" }));

    expect(store.getByTraceId("trace_a")).toHaveLength(1);
    expect(store.getByTraceId("trace_b")).toHaveLength(1);
    expect(store.getByTraceId("trace_c")).toHaveLength(0);
  });

  it("supports batched insertMany inside a single transaction", () => {
    const events = Array.from({ length: 50 }, (_, i) =>
      makeEvent({ id: `bulk_${i}`, trace_id: "trace_bulk" }),
    );
    store.insertMany(events);
    expect(store.getByTraceId("trace_bulk")).toHaveLength(50);
  });

  it("rolls back the whole batch if one insert in insertMany fails", () => {
    const events = [
      makeEvent({ id: "dup", trace_id: "trace_rollback" }),
      makeEvent({ id: "dup", trace_id: "trace_rollback" }), // duplicate id -> should fail
    ];
    expect(() => store.insertMany(events)).toThrow();
    // because the transaction rolled back, neither row should be present
    expect(store.getByTraceId("trace_rollback")).toHaveLength(0);
  });

  it("queries by service, optionally filtered by a since timestamp", () => {
    const older = new Date(Date.now() - 10_000).toISOString();
    const newer = new Date().toISOString();

    store.insert(
      makeEvent({ id: "svc_old", service: "payment-service", timestamp: older, trace_id: "t_old" }),
    );
    store.insert(
      makeEvent({ id: "svc_new", service: "payment-service", timestamp: newer, trace_id: "t_new" }),
    );

    expect(store.getByService("payment-service")).toHaveLength(2);

    const since = new Date(Date.now() - 5000).toISOString();
    const filtered = store.getByService("payment-service", since);
    expect(filtered.map((r) => r.id)).toEqual(["svc_new"]);
  });

  it("enforces primary key uniqueness on id", () => {
    store.insert(makeEvent({ id: "unique_1" }));
    expect(() => store.insert(makeEvent({ id: "unique_1" }))).toThrow();
  });

  describe("getRecent", () => {
    it("returns events across all traces/services ordered newest first", () => {
      const t0 = new Date(Date.now() - 3000).toISOString();
      const t1 = new Date(Date.now() - 2000).toISOString();
      const t2 = new Date(Date.now() - 1000).toISOString();

      store.insert(makeEvent({ id: "r0", timestamp: t0, trace_id: "trace_x" }));
      store.insert(makeEvent({ id: "r1", timestamp: t1, trace_id: "trace_y" }));
      store.insert(makeEvent({ id: "r2", timestamp: t2, trace_id: "trace_z" }));

      const rows = store.getRecent();
      expect(rows.map((r) => r.id)).toEqual(["r2", "r1", "r0"]);
    });

    it("filters by type", () => {
      store.insert(makeEvent({ id: "trace_ev", type: "trace" }));
      store.insert(makeEvent({ id: "log_ev", type: "log" }));

      const rows = store.getRecent({ type: "log" });
      expect(rows.map((r) => r.id)).toEqual(["log_ev"]);
    });

    it("filters by service", () => {
      store.insert(makeEvent({ id: "svc_a", service: "service-a" }));
      store.insert(makeEvent({ id: "svc_b", service: "service-b" }));

      const rows = store.getRecent({ service: "service-b" });
      expect(rows.map((r) => r.id)).toEqual(["svc_b"]);
    });

    it("filters by sinceIso", () => {
      const old = new Date(Date.now() - 100_000).toISOString();
      const recent = new Date().toISOString();

      store.insert(makeEvent({ id: "old_one", timestamp: old }));
      store.insert(makeEvent({ id: "recent_one", timestamp: recent }));

      const since = new Date(Date.now() - 5000).toISOString();
      const rows = store.getRecent({ sinceIso: since });
      expect(rows.map((r) => r.id)).toEqual(["recent_one"]);
    });

    it("respects the limit option and defaults to 50", () => {
      const events = Array.from({ length: 60 }, (_, i) =>
        makeEvent({ id: `bulk_${i}`, trace_id: `trace_${i}` }),
      );
      store.insertMany(events);

      expect(store.getRecent()).toHaveLength(50);
      expect(store.getRecent({ limit: 5 })).toHaveLength(5);
    });

    it("combines multiple filters together", () => {
      store.insert(
        makeEvent({ id: "match", type: "error", service: "payment-service" }),
      );
      store.insert(
        makeEvent({ id: "wrong_type", type: "log", service: "payment-service" }),
      );
      store.insert(
        makeEvent({ id: "wrong_service", type: "error", service: "other-service" }),
      );

      const rows = store.getRecent({ type: "error", service: "payment-service" });
      expect(rows.map((r) => r.id)).toEqual(["match"]);
    });
  });

  describe("getErrors", () => {
    it("returns events with severity error or critical regardless of type", () => {
      store.insert(makeEvent({ id: "err_trace", type: "trace", severity: "error" }));
      store.insert(makeEvent({ id: "err_llm", type: "llm_call", severity: "critical", attributes: { model: "x", provider: "y" } }));
      store.insert(makeEvent({ id: "ok_trace", type: "trace", severity: "info" }));
      store.insert(makeEvent({ id: "warn_trace", type: "trace", severity: "warn" }));

      const rows = store.getErrors();
      expect(rows.map((r) => r.id).sort()).toEqual(["err_llm", "err_trace"]);
    });

    it("filters errors by service", () => {
      store.insert(makeEvent({ id: "e1", service: "svc-a", severity: "error" }));
      store.insert(makeEvent({ id: "e2", service: "svc-b", severity: "error" }));

      const rows = store.getErrors({ service: "svc-a" });
      expect(rows.map((r) => r.id)).toEqual(["e1"]);
    });

    it("filters errors by sinceIso", () => {
      const old = new Date(Date.now() - 100_000).toISOString();
      const recent = new Date().toISOString();
      store.insert(makeEvent({ id: "e_old", severity: "error", timestamp: old }));
      store.insert(makeEvent({ id: "e_new", severity: "error", timestamp: recent }));

      const since = new Date(Date.now() - 5000).toISOString();
      const rows = store.getErrors({ sinceIso: since });
      expect(rows.map((r) => r.id)).toEqual(["e_new"]);
    });

    it("respects limit and orders newest first", () => {
      const events = Array.from({ length: 5 }, (_, i) =>
        makeEvent({
          id: `err_${i}`,
          severity: "error",
          timestamp: new Date(Date.now() - i * 1000).toISOString(),
        }),
      );
      store.insertMany(events);

      const rows = store.getErrors({ limit: 2 });
      expect(rows.map((r) => r.id)).toEqual(["err_0", "err_1"]);
    });
  });

  describe("getServices", () => {
    it("aggregates event counts per service", () => {
      store.insert(makeEvent({ id: "a1", service: "service-a" }));
      store.insert(makeEvent({ id: "a2", service: "service-a" }));
      store.insert(makeEvent({ id: "b1", service: "service-b" }));

      const summaries = store.getServices();
      const byService = Object.fromEntries(summaries.map((s) => [s.service, s]));

      expect(byService["service-a"].event_count).toBe(2);
      expect(byService["service-b"].event_count).toBe(1);
    });

    it("counts errors separately from total events", () => {
      store.insert(makeEvent({ id: "ok1", service: "service-a", severity: "info" }));
      store.insert(makeEvent({ id: "bad1", service: "service-a", severity: "error" }));
      store.insert(makeEvent({ id: "bad2", service: "service-a", severity: "critical" }));

      const summaries = store.getServices();
      const serviceA = summaries.find((s) => s.service === "service-a");
      expect(serviceA?.event_count).toBe(3);
      expect(serviceA?.error_count).toBe(2);
    });

    it("reports last_seen as the most recent timestamp for that service", () => {
      const older = new Date(Date.now() - 10_000).toISOString();
      const newer = new Date().toISOString();
      store.insert(makeEvent({ id: "first", service: "service-a", timestamp: older }));
      store.insert(makeEvent({ id: "second", service: "service-a", timestamp: newer }));

      const summaries = store.getServices();
      const serviceA = summaries.find((s) => s.service === "service-a");
      expect(serviceA?.last_seen).toBe(newer);
    });

    it("returns an empty array when there are no events", () => {
      expect(store.getServices()).toEqual([]);
    });
  });
});
describe("SqliteStore incident dedup by trace_id", () => {
  it("upserts on trace_id instead of inserting duplicate incident rows", () => {
    const store = new SqliteStore(":memory:");
    store.recordIncident({
      traceId: "trace-dup",
      windowStart: "2026-01-01T00:00:00.000Z",
      windowEnd: "2026-01-01T00:05:00.000Z",
      services: ["svc-a"],
      fingerprint: JSON.stringify({ services: ["svc-a"] }),
      summary: "first pass",
    });
    store.recordIncident({
      traceId: "trace-dup",
      windowStart: "2026-01-01T00:00:00.000Z",
      windowEnd: "2026-01-01T00:06:00.000Z",
      services: ["svc-a"],
      fingerprint: JSON.stringify({ services: ["svc-a"] }),
      summary: "second pass",
    });

    const rows = store.getRecentIncidents(200).filter((r) => r.trace_id === "trace-dup");
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe("second pass");
    store.close();
  });

  it("preserves resolution fields on a resolved incident when re-recorded", () => {
    const store = new SqliteStore(":memory:");
    store.recordIncident({
      traceId: "trace-resolved",
      windowStart: "2026-01-01T00:00:00.000Z",
      windowEnd: "2026-01-01T00:05:00.000Z",
      services: ["svc-a"],
      fingerprint: JSON.stringify({ services: ["svc-a"] }),
      summary: "initial",
    });
    store.resolveIncident({
      traceId: "trace-resolved",
      status: "resolved",
      notes: "fixed it",
      appliedRecommendation: "added retry",
    });
    store.recordIncident({
      traceId: "trace-resolved",
      windowStart: "2026-01-01T00:00:00.000Z",
      windowEnd: "2026-01-01T00:05:00.000Z",
      services: ["svc-a"],
      fingerprint: JSON.stringify({ services: ["svc-a"] }),
      summary: "re-investigated",
    });

    const rows = store.getRecentIncidents(200).filter((r) => r.trace_id === "trace-resolved");
    expect(rows).toHaveLength(1);
    expect(rows[0].resolution_status).toBe("resolved");
    expect(rows[0].applied_recommendation).toBe("added retry");
    store.close();
  });
});
