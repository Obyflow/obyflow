from datetime import datetime, timezone

import pytest

from obyflow.events import EventValidationError, safe_validate_event, validate_event


def _base_event(**overrides):
    base = {
        "id": "evt_1",
        "type": "trace",
        "trace_id": "trace_1",
        "request_id": "req_1",
        "service": "checkout",
        "host": None,
        "container": None,
        "deployment_id": None,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "duration_ms": 12.5,
        "attributes": {"method": "GET"},
        "severity": "info",
    }
    base.update(overrides)
    return base


def test_validate_event_accepts_valid_trace_event():
    event = validate_event(_base_event())
    assert event.type == "trace"
    assert event.service == "checkout"


def test_validate_event_rejects_bad_envelope():
    with pytest.raises(EventValidationError):
        validate_event(_base_event(service=123))


def test_validate_event_rejects_bad_attributes_for_type():
    with pytest.raises(EventValidationError):
        validate_event(
            _base_event(type="embedding", attributes={"model": "text-embedding-3"})
        )


def test_chain_event_requires_trace_id():
    with pytest.raises(EventValidationError):
        validate_event(
            _base_event(
                type="chain",
                trace_id=None,
                attributes={
                    "framework": "langchain",
                    "run_id": "run_1",
                    "status": "success",
                },
            )
        )


def test_parent_span_id_requires_trace_id():
    with pytest.raises(EventValidationError):
        validate_event(
            _base_event(
                trace_id=None,
                parent_span_id="span_parent",
            )
        )


def test_span_id_must_differ_from_parent_span_id():
    with pytest.raises(EventValidationError):
        validate_event(
            _base_event(
                span_id="span_1",
                parent_span_id="span_1",
            )
        )


def test_safe_validate_event_returns_error_without_raising():
    result = safe_validate_event(_base_event(service=None))
    assert result["ok"] is False
    assert isinstance(result["error"], EventValidationError)
