from __future__ import annotations

import time
import uuid
from datetime import datetime, timezone
from typing import Optional

from ..client import SqliteStore
from ..context import TraceContext, reset_trace_context, set_trace_context
from ..events import validate_event
from ..resource_attributes import ResourceAttributesInput, resolve_resource_attributes
from ..tracing_headers import extract_inbound_trace_headers


class ObyflowASGIMiddleware:
    def __init__(
        self,
        app,
        service: str,
        store: SqliteStore,
        deployment_id: Optional[str] = None,
        resource_attributes: Optional[ResourceAttributesInput] = None,
    ):
        self.app = app
        self.service = service
        self.store = store
        self.deployment_id = deployment_id
        self.resource_attributes = resource_attributes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = {
            k.decode("latin-1").lower(): v.decode("latin-1")
            for k, v in scope.get("headers", [])
        }
        trace_id, parent_span_id = extract_inbound_trace_headers(
            headers, lambda: str(uuid.uuid4())
        )
        request_id = str(uuid.uuid4())
        span_id = str(uuid.uuid4())
        started_at = time.monotonic()
        timestamp = datetime.now(timezone.utc).isoformat()
        status_code_holder = {"code": None}

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                status_code_holder["code"] = message["status"]
            await send(message)

        token = set_trace_context(
            TraceContext(
                trace_id=trace_id,
                request_id=request_id,
                span_id=span_id,
                parent_span_id=parent_span_id,
            )
        )
        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            status_code_holder["code"] = 500
            raise
        finally:
            reset_trace_context(token)
            duration_ms = (time.monotonic() - started_at) * 1000
            status_code = status_code_holder["code"] or 0
            if status_code >= 500:
                severity = "error"
            elif status_code >= 400:
                severity = "warn"
            else:
                severity = "info"
            try:
                event = validate_event(
                    {
                        "id": str(uuid.uuid4()),
                        "type": "trace",
                        "trace_id": trace_id,
                        "span_id": span_id,
                        "parent_span_id": parent_span_id,
                        "request_id": request_id,
                        "service": self.service,
                        "host": None,
                        "container": None,
                        "deployment_id": self.deployment_id,
                        "timestamp": timestamp,
                        "duration_ms": duration_ms,
                        "attributes": {
                            "method": scope.get("method"),
                            "url": scope.get("path"),
                            "status_code": status_code,
                        },
                        "resource_attributes": resolve_resource_attributes(
                            self.resource_attributes
                        ),
                        "severity": severity,
                    }
                )
                self.store.insert(event)
            except Exception as exc:
                self.store.record_telemetry_failure(
                    operation="asgi.trace_event",
                    service=self.service,
                    reason=str(exc),
                )
