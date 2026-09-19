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


def _headers_from_environ(environ: dict) -> dict:
    headers = {}
    for key, value in environ.items():
        if key == "CONTENT_TYPE":
            headers["content-type"] = value
        elif key == "CONTENT_LENGTH":
            headers["content-length"] = value
        elif key.startswith("HTTP_"):
            header_name = key[len("HTTP_"):].replace("_", "-").lower()
            headers[header_name] = value
    return headers


class ObyflowWSGIMiddleware:
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

    def __call__(self, environ, start_response):
        headers = _headers_from_environ(environ)
        trace_id, parent_span_id = extract_inbound_trace_headers(
            headers, lambda: str(uuid.uuid4())
        )
        request_id = str(uuid.uuid4())
        span_id = str(uuid.uuid4())
        started_at = time.monotonic()
        timestamp = datetime.now(timezone.utc).isoformat()
        status_code_holder = {"code": None}

        def start_response_wrapper(status, response_headers, exc_info=None):
            try:
                status_code_holder["code"] = int(status.split(" ", 1)[0])
            except (ValueError, AttributeError):
                status_code_holder["code"] = None
            return start_response(status, response_headers, exc_info)

        token = set_trace_context(
            TraceContext(
                trace_id=trace_id,
                request_id=request_id,
                span_id=span_id,
                parent_span_id=parent_span_id,
            )
        )
        try:
            result = self.app(environ, start_response_wrapper)
            for chunk in result:
                yield chunk
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
                            "method": environ.get("REQUEST_METHOD"),
                            "url": environ.get("PATH_INFO"),
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
                    operation="wsgi.trace_event",
                    service=self.service,
                    reason=str(exc),
                )
