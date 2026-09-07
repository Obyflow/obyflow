from datetime import datetime, timezone

import pytest

sklearn = pytest.importorskip("sklearn")

from obyflow.analysis.anomaly import detect_ml_anomalies
from obyflow.events import Event


def _make_event(event_id, duration_ms, severity=None):
    return Event(
        id=event_id,
        type="trace",
        trace_id=None,
        request_id=None,
        service="checkout",
        host=None,
        container=None,
        deployment_id=None,
        timestamp=datetime.now(timezone.utc).isoformat(),
        duration_ms=duration_ms,
        attributes={},
        severity=severity,
    )


def test_detect_ml_anomalies_returns_empty_below_min_samples():
    events = [_make_event(f"e{i}", 100.0) for i in range(3)]
    result = detect_ml_anomalies(events, "checkout")
    assert result == []


def test_detect_ml_anomalies_ignores_other_services():
    events = [_make_event(f"e{i}", 100.0) for i in range(3)]
    events[0].service = "other-service"
    result = detect_ml_anomalies(events, "checkout", min_samples=5)
    assert result == []


def test_detect_ml_anomalies_flags_outlier():
    events = [_make_event(f"e{i}", 100.0 + i) for i in range(20)]
    events.append(_make_event("spike", 50000.0))
    result = detect_ml_anomalies(events, "checkout", min_samples=5)
    assert len(result) == 21
    spike_result = next(r for r in result if r["event_id"] == "spike")
    assert spike_result["is_anomalous"] is True
    assert spike_result["severity"] in ("medium", "high")


def test_detect_ml_anomalies_result_shape():
    events = [_make_event(f"e{i}", 100.0 + i, severity="info") for i in range(10)]
    result = detect_ml_anomalies(events, "checkout", min_samples=5)
    assert len(result) == 10
    for item in result:
        assert item["service"] == "checkout"
        assert isinstance(item["anomaly_score"], float)
        assert isinstance(item["z_score"], float)
        assert item["severity"] in ("none", "low", "medium", "high")
        assert isinstance(item["is_anomalous"], bool)


def test_detect_ml_anomalies_with_custom_thresholds():
    events = [_make_event(f"e{i}", 100.0 + i) for i in range(20)]
    events.append(_make_event("spike", 50000.0))
    result = detect_ml_anomalies(
        events,
        "checkout",
        min_samples=5,
        low_threshold=0.5,
        medium_threshold=1.0,
        high_threshold=1.5
    )
    spike_result = next(r for r in result if r["event_id"] == "spike")
    assert spike_result["severity"] == "high"