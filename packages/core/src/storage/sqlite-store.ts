import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { Event } from "../event-model/event.schema.js";
import { redactEvent, DEFAULT_REDACTION_CONFIG } from "../evidence/redact.js";
import type { RedactionConfig } from "../evidence/redact.js";

const TELEMETRY_FAILURES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS telemetry_failures (
  id         TEXT PRIMARY KEY,
  timestamp  TEXT NOT NULL,
  service    TEXT,
  operation  TEXT NOT NULL,
  reason     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telemetry_failures_timestamp ON telemetry_failures(timestamp);
CREATE INDEX IF NOT EXISTS idx_telemetry_failures_service   ON telemetry_failures(service);
`;

const INCIDENTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS incidents (
  id           TEXT PRIMARY KEY,
  trace_id     TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end   TEXT NOT NULL,
  services     TEXT NOT NULL,
  fingerprint  TEXT NOT NULL,
  summary      TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_incidents_created_at ON incidents(created_at);
CREATE INDEX IF NOT EXISTS idx_incidents_trace_id   ON incidents(trace_id);
`;

function dedupeIncidentsByTraceId(db: DatabaseType): void {
  db.exec(`
    DELETE FROM incidents
    WHERE id NOT IN (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY trace_id
                 ORDER BY (resolution_status IS NOT NULL) DESC, created_at DESC
               ) AS rn
        FROM incidents
      )
      WHERE rn = 1
    );
  `);
}

function migrateIncidentTraceIdUnique(db: DatabaseType): void {
  dedupeIncidentsByTraceId(db);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_incidents_trace_id_unique ON incidents(trace_id);`);
}

const INCIDENT_RESOLUTION_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "resolution_status", ddl: "ALTER TABLE incidents ADD COLUMN resolution_status TEXT" },
  { name: "resolution_notes", ddl: "ALTER TABLE incidents ADD COLUMN resolution_notes TEXT" },
  {
    name: "applied_recommendation",
    ddl: "ALTER TABLE incidents ADD COLUMN applied_recommendation TEXT",
  },
  { name: "resolved_at", ddl: "ALTER TABLE incidents ADD COLUMN resolved_at TEXT" },
];

function migrateIncidentResolutionColumns(db: DatabaseType): void {
  const existing = new Set(
    (db.prepare("PRAGMA table_info(incidents)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  for (const column of INCIDENT_RESOLUTION_COLUMNS) {
    if (!existing.has(column.name)) {
      db.exec(column.ddl);
    }
  }
}

export interface IncidentRow {
  id: string;
  trace_id: string;
  window_start: string;
  window_end: string;
  services: string;
  fingerprint: string;
  summary: string | null;
  created_at: string;
  resolution_status: string | null;
  resolution_notes: string | null;
  applied_recommendation: string | null;
  resolved_at: string | null;
}

export type IncidentResolutionStatus = "resolved" | "not_resolved" | "partial";

export interface ResolveIncidentInput {
  traceId: string;
  status: IncidentResolutionStatus;
  notes?: string | null;
  appliedRecommendation?: string | null;
}

export interface RecordIncidentInput {
  traceId: string;
  windowStart: string;
  windowEnd: string;
  services: string[];
  fingerprint: string;
  summary?: string | null;
}

export interface TelemetryFailureRow {
  id: string;
  timestamp: string;
  service: string | null;
  operation: string;
  reason: string;
}

export interface RecordTelemetryFailureInput {
  operation: string;
  reason: string;
  service?: string | null;
  timestamp?: string;
}

export interface TelemetryFailureFilter {
  service?: string;
  sinceIso?: string;
  untilIso?: string;
  limit?: number;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  id                 TEXT PRIMARY KEY,
  type               TEXT NOT NULL,
  trace_id           TEXT,
  request_id         TEXT,
  service            TEXT NOT NULL,
  host               TEXT,
  container          TEXT,
  deployment_id      TEXT,
  timestamp          TEXT NOT NULL,
  duration_ms        REAL,
  attributes         TEXT NOT NULL,
  severity           TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_trace_id   ON events(trace_id);
CREATE INDEX IF NOT EXISTS idx_events_service    ON events(service);
CREATE INDEX IF NOT EXISTS idx_events_timestamp  ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_deployment ON events(deployment_id);
CREATE INDEX IF NOT EXISTS idx_events_type       ON events(type);
`;

const SPAN_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "span_id", ddl: "ALTER TABLE events ADD COLUMN span_id TEXT" },
  { name: "parent_span_id", ddl: "ALTER TABLE events ADD COLUMN parent_span_id TEXT" },
  { name: "resource_attributes", ddl: "ALTER TABLE events ADD COLUMN resource_attributes TEXT" },
];

function migrateSpanColumns(db: DatabaseType): void {
  const existing = new Set(
    (db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  for (const column of SPAN_COLUMNS) {
    if (!existing.has(column.name)) {
      db.exec(column.ddl);
    }
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_events_span_id ON events(span_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_events_parent_span_id ON events(parent_span_id)");
}

export interface EventRow {
  id: string;
  type: string;
  trace_id: string | null;
  span_id: string | null;
  parent_span_id: string | null;
  request_id: string | null;
  service: string;
  host: string | null;
  container: string | null;
  deployment_id: string | null;
  timestamp: string;
  duration_ms: number | null;
  attributes: string;
  resource_attributes: string | null;
  severity: string | null;
}

export interface ServiceSummary {
  service: string;
  event_count: number;
  last_seen: string;
  error_count: number;
}

export interface ExportFilter {
  type?: string;
  service?: string;
  sinceIso?: string;
  untilIso?: string;
  limit?: number;
}

export class SqliteStore {
  private db: DatabaseType;
  private redaction: RedactionConfig;

  constructor(dbPath: string = "obyflow.db", redaction: RedactionConfig = DEFAULT_REDACTION_CONFIG) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA_SQL);
    migrateSpanColumns(this.db);
    this.db.exec(TELEMETRY_FAILURES_SCHEMA_SQL);
    this.db.exec(INCIDENTS_SCHEMA_SQL);
    migrateIncidentResolutionColumns(this.db);
    migrateIncidentTraceIdUnique(this.db);
    this.redaction = redaction;
  }

  private applyIngestionRedaction(event: Event): Event {
    if (!this.redaction.enabled || this.redaction.applied_at !== "ingestion") {
      return event;
    }
    return redactEvent(event, this.redaction);
  }

  private toInsertParams(event: Event) {
    const redacted = this.applyIngestionRedaction(event);
    return {
      ...redacted,
      span_id: redacted.span_id ?? null,
      parent_span_id: redacted.parent_span_id ?? null,
      attributes: JSON.stringify(redacted.attributes),
      resource_attributes: redacted.resource_attributes
        ? JSON.stringify(redacted.resource_attributes)
        : null,
    };
  }

  insert(event: Event): void {
    const stmt = this.db.prepare(`
      INSERT INTO events (
        id, type, trace_id, span_id, parent_span_id, request_id, service, host, container,
        deployment_id, timestamp, duration_ms, attributes, resource_attributes, severity
      ) VALUES (
        @id, @type, @trace_id, @span_id, @parent_span_id, @request_id, @service, @host, @container,
        @deployment_id, @timestamp, @duration_ms, @attributes, @resource_attributes, @severity
      )
    `);
    stmt.run(this.toInsertParams(event));
  }

  insertMany(events: Event[]): void {
    const insertOne = this.db.prepare(`
      INSERT INTO events (
        id, type, trace_id, span_id, parent_span_id, request_id, service, host, container,
        deployment_id, timestamp, duration_ms, attributes, resource_attributes, severity
      ) VALUES (
        @id, @type, @trace_id, @span_id, @parent_span_id, @request_id, @service, @host, @container,
        @deployment_id, @timestamp, @duration_ms, @attributes, @resource_attributes, @severity
      )
    `);
    const runAll = this.db.transaction((rows: Event[]) => {
      for (const e of rows) {
        insertOne.run(this.toInsertParams(e));
      }
    });
    runAll(events);
  }

  recordTelemetryFailure(failure: RecordTelemetryFailureInput): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO telemetry_failures (id, timestamp, service, operation, reason)
        VALUES (@id, @timestamp, @service, @operation, @reason)
      `);
      stmt.run({
        id: randomUUID(),
        timestamp: failure.timestamp ?? new Date().toISOString(),
        service: failure.service ?? null,
        operation: failure.operation,
        reason: failure.reason,
      });
    } catch {
      // Recording telemetry health must never itself throw or take down the host app.
    }
  }

  getTelemetryFailureCount(filter: TelemetryFailureFilter = {}): number {
    const { conditions, params } = this.buildTelemetryFailureFilter(filter);
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const row = this.db
      .prepare(`SELECT COUNT(*) as c FROM telemetry_failures ${where}`)
      .get(...params) as { c: number };
    return row.c;
  }

  getTelemetryFailures(filter: TelemetryFailureFilter = {}): TelemetryFailureRow[] {
    const { conditions, params } = this.buildTelemetryFailureFilter(filter);
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filter.limit ?? 20;
    return this.db
      .prepare(
        `SELECT * FROM telemetry_failures ${where} ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(...params, limit) as TelemetryFailureRow[];
  }

  private buildTelemetryFailureFilter(
    filter: TelemetryFailureFilter,
  ): { conditions: string[]; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.service) {
      conditions.push("service = ?");
      params.push(filter.service);
    }
    if (filter.sinceIso) {
      conditions.push("timestamp >= ?");
      params.push(filter.sinceIso);
    }
    if (filter.untilIso) {
      conditions.push("timestamp <= ?");
      params.push(filter.untilIso);
    }
    return { conditions, params };
  }

  getByTraceId(traceId: string): EventRow[] {
    return this.db
      .prepare(`SELECT * FROM events WHERE trace_id = ? ORDER BY timestamp ASC`)
      .all(traceId) as EventRow[];
  }

  getBySpanId(spanId: string): EventRow | undefined {
    return this.db
      .prepare(`SELECT * FROM events WHERE span_id = ? LIMIT 1`)
      .get(spanId) as EventRow | undefined;
  }

  getByParentSpanId(parentSpanId: string): EventRow[] {
    return this.db
      .prepare(`SELECT * FROM events WHERE parent_span_id = ? ORDER BY timestamp ASC`)
      .all(parentSpanId) as EventRow[];
  }

  getByService(service: string, sinceIso?: string): EventRow[] {
    if (sinceIso) {
      return this.db
        .prepare(
          `SELECT * FROM events WHERE service = ? AND timestamp >= ? ORDER BY timestamp ASC`,
        )
        .all(service, sinceIso) as EventRow[];
    }
    return this.db
      .prepare(`SELECT * FROM events WHERE service = ? ORDER BY timestamp ASC`)
      .all(service) as EventRow[];
  }

  getByServiceWindow(service: string, startIso: string, endIso: string): EventRow[] {
    return this.db
      .prepare(
        `SELECT * FROM events WHERE service = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC`,
      )
      .all(service, startIso, endIso) as EventRow[];
  }

  getRecent(filter: {
    type?: string;
    service?: string;
    sinceIso?: string;
    limit?: number;
  } = {}): EventRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.type) {
      conditions.push("type = ?");
      params.push(filter.type);
    }
    if (filter.service) {
      conditions.push("service = ?");
      params.push(filter.service);
    }
    if (filter.sinceIso) {
      conditions.push("timestamp >= ?");
      params.push(filter.sinceIso);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filter.limit ?? 50;

    return this.db
      .prepare(
        `SELECT * FROM events ${where} ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(...params, limit) as EventRow[];
  }

  getErrors(filter: {
    service?: string;
    sinceIso?: string;
    limit?: number;
  } = {}): EventRow[] {
    const conditions: string[] = ["severity IN ('error', 'critical')"];
    const params: unknown[] = [];

    if (filter.service) {
      conditions.push("service = ?");
      params.push(filter.service);
    }
    if (filter.sinceIso) {
      conditions.push("timestamp >= ?");
      params.push(filter.sinceIso);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;
    const limit = filter.limit ?? 50;

    return this.db
      .prepare(`SELECT * FROM events ${where} ORDER BY timestamp DESC LIMIT ?`)
      .all(...params, limit) as EventRow[];
  }

  getServices(): ServiceSummary[] {
    return this.db
      .prepare(
        `SELECT
           service,
           COUNT(*) as event_count,
           MAX(timestamp) as last_seen,
           SUM(CASE WHEN severity IN ('error', 'critical') THEN 1 ELSE 0 END) as error_count
         FROM events
         GROUP BY service
         ORDER BY last_seen DESC`,
      )
      .all() as ServiceSummary[];
  }

  exportEvents(filter: ExportFilter = {}): EventRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.type) {
      conditions.push("type = ?");
      params.push(filter.type);
    }
    if (filter.service) {
      conditions.push("service = ?");
      params.push(filter.service);
    }
    if (filter.sinceIso) {
      conditions.push("timestamp >= ?");
      params.push(filter.sinceIso);
    }
    if (filter.untilIso) {
      conditions.push("timestamp <= ?");
      params.push(filter.untilIso);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitSql = filter.limit ? " LIMIT ?" : "";
    const stmt = this.db.prepare(
      `SELECT * FROM events ${where} ORDER BY timestamp ASC${limitSql}`,
    );
    return (filter.limit ? stmt.all(...params, filter.limit) : stmt.all(...params)) as EventRow[];
  }

  prune(beforeIso: string): number {
    const result = this.db.prepare(`DELETE FROM events WHERE timestamp < ?`).run(beforeIso);
    this.db.exec("VACUUM");
    return result.changes;
  }

  countAll(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as c FROM events`).get() as { c: number };
    return row.c;
  }

  countOlderThan(beforeIso: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as c FROM events WHERE timestamp < ?`)
      .get(beforeIso) as { c: number };
    return row.c;
  }

  oldestTimestamp(): string | null {
    const row = this.db.prepare(`SELECT MIN(timestamp) as t FROM events`).get() as {
      t: string | null;
    };
    return row.t;
  }

  recordIncident(input: RecordIncidentInput): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO incidents (id, trace_id, window_start, window_end, services, fingerprint, summary, created_at)
        VALUES (@id, @trace_id, @window_start, @window_end, @services, @fingerprint, @summary, @created_at)
        ON CONFLICT(trace_id) DO UPDATE SET
          window_start = excluded.window_start,
          window_end = excluded.window_end,
          services = excluded.services,
          fingerprint = excluded.fingerprint,
          summary = excluded.summary,
          created_at = excluded.created_at
      `);
      stmt.run({
        id: randomUUID(),
        trace_id: input.traceId,
        window_start: input.windowStart,
        window_end: input.windowEnd,
        services: JSON.stringify(input.services),
        fingerprint: input.fingerprint,
        summary: input.summary ?? null,
        created_at: new Date().toISOString(),
      });
    } catch {
      return;
    }
  }

  getRecentIncidents(limit: number = 200): IncidentRow[] {
    return this.db
      .prepare(`SELECT * FROM incidents ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as IncidentRow[];
  }

  resolveIncident(input: ResolveIncidentInput): IncidentRow | null {
    const existing = this.db
      .prepare(`SELECT * FROM incidents WHERE trace_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(input.traceId) as IncidentRow | undefined;
    if (!existing) return null;

    const resolvedAt = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE incidents
         SET resolution_status = @resolution_status,
             resolution_notes = @resolution_notes,
             applied_recommendation = @applied_recommendation,
             resolved_at = @resolved_at
         WHERE id = @id`,
      )
      .run({
        id: existing.id,
        resolution_status: input.status,
        resolution_notes: input.notes ?? null,
        applied_recommendation: input.appliedRecommendation ?? null,
        resolved_at: resolvedAt,
      });

    return {
      ...existing,
      resolution_status: input.status,
      resolution_notes: input.notes ?? null,
      applied_recommendation: input.appliedRecommendation ?? null,
      resolved_at: resolvedAt,
    };
  }

  close(): void {
    this.db.close();
  }
}

export function rowToEvent(row: EventRow): Event {
  return {
    ...row,
    span_id: row.span_id ?? null,
    parent_span_id: row.parent_span_id ?? null,
    duration_ms: row.duration_ms,
    attributes: JSON.parse(row.attributes),
    resource_attributes: row.resource_attributes ? JSON.parse(row.resource_attributes) : null,
  } as Event;
}
