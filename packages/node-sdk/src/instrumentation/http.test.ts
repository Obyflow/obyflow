import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { SqliteStore } from "@obyflow/core";
import { instrumentHttp, _resetHttpInstrumentationForTests } from "./http.js";

function request(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path, headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function withServer(
  handler: http.RequestListener,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("node-sdk inbound http instrumentation", () => {
  afterEach(() => {
    _resetHttpInstrumentationForTests();
  });

  it("generates a new trace_id when no incoming trace header is present", async () => {
    const store = new SqliteStore(":memory:");
    instrumentHttp({ service: "svc-generate", store });

    await withServer(
      (_req, res) => {
        res.writeHead(200);
        res.end("ok");
      },
      async (port) => {
        await request(port, "/whatever");
        await new Promise((resolve) => setTimeout(resolve, 20));

        const rows = store.getByService("svc-generate");
        expect(rows).toHaveLength(1);
        expect(typeof rows[0].trace_id).toBe("string");
        expect(rows[0].trace_id).not.toBe("");
      },
    );
  });

  it("propagates an incoming x-obyflow-trace-id header instead of generating a new one", async () => {
    const store = new SqliteStore(":memory:");
    instrumentHttp({ service: "svc-propagate", store });

    await withServer(
      (_req, res) => {
        res.writeHead(200);
        res.end("ok");
      },
      async (port) => {
        const incomingTraceId = "trace_fixed_123";
        await request(port, "/whatever", { "x-obyflow-trace-id": incomingTraceId });
        await new Promise((resolve) => setTimeout(resolve, 20));

        const rows = store.getByTraceId(incomingTraceId);
        expect(rows).toHaveLength(1);
      },
    );
  });

  it("assigns a span_id to every captured trace event and no parent_span_id when none was provided", async () => {
    const store = new SqliteStore(":memory:");
    instrumentHttp({ service: "svc-span", store });

    await withServer(
      (_req, res) => {
        res.writeHead(200);
        res.end("ok");
      },
      async (port) => {
        await request(port, "/span-check");
        await new Promise((resolve) => setTimeout(resolve, 20));

        const rows = store.getByService("svc-span");
        expect(rows).toHaveLength(1);
        expect(typeof rows[0].span_id).toBe("string");
        expect(rows[0].span_id).not.toBe("");
        expect(rows[0].parent_span_id).toBeNull();
      },
    );
  });

  it("uses an incoming x-obyflow-parent-span-id header as parent_span_id", async () => {
    const store = new SqliteStore(":memory:");
    instrumentHttp({ service: "svc-parent", store });

    await withServer(
      (_req, res) => {
        res.writeHead(200);
        res.end("ok");
      },
      async (port) => {
        await request(port, "/child", { "x-obyflow-parent-span-id": "span_upstream_1" });
        await new Promise((resolve) => setTimeout(resolve, 20));

        const rows = store.getByService("svc-parent");
        expect(rows[0].parent_span_id).toBe("span_upstream_1");
      },
    );
  });

  it("captures method, url, and status_code and marks 5xx responses as severity error", async () => {
    const store = new SqliteStore(":memory:");
    instrumentHttp({ service: "svc-status", store });

    await withServer(
      (_req, res) => {
        res.writeHead(500);
        res.end("boom");
      },
      async (port) => {
        await request(port, "/fail?x=1");
        await new Promise((resolve) => setTimeout(resolve, 20));

        const rows = store.getByService("svc-status");
        expect(rows).toHaveLength(1);
        expect(rows[0].severity).toBe("error");
        const attrs = JSON.parse(rows[0].attributes as unknown as string);
        expect(attrs.method).toBe("GET");
        expect(attrs.url).toBe("/fail?x=1");
        expect(attrs.status_code).toBe(500);
      },
    );
  });

  it("marks 4xx responses as severity warn", async () => {
    const store = new SqliteStore(":memory:");
    instrumentHttp({ service: "svc-client-error", store });

    await withServer(
      (_req, res) => {
        res.writeHead(404);
        res.end("not found");
      },
      async (port) => {
        await request(port, "/missing");
        await new Promise((resolve) => setTimeout(resolve, 20));

        const rows = store.getByService("svc-client-error");
        expect(rows).toHaveLength(1);
        expect(rows[0].severity).toBe("warn");
      },
    );
  });

  it("captures a distinct trace event per request across multiple concurrent requests", async () => {
    const store = new SqliteStore(":memory:");
    instrumentHttp({ service: "svc-concurrent", store });

    await withServer(
      (_req, res) => {
        res.writeHead(200);
        res.end("ok");
      },
      async (port) => {
        await Promise.all([
          request(port, "/a"),
          request(port, "/b"),
          request(port, "/c"),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 30));

        const rows = store.getByService("svc-concurrent");
        expect(rows).toHaveLength(3);
        const traceIds = new Set(rows.map((r) => r.trace_id));
        const spanIds = new Set(rows.map((r) => r.span_id));
        expect(traceIds.size).toBe(3);
        expect(spanIds.size).toBe(3);
      },
    );
  });

  it("throws when called without a valid store", () => {
    expect(() => instrumentHttp({} as unknown as Parameters<typeof instrumentHttp>[0])).toThrow(
      TypeError,
    );
  });
});
