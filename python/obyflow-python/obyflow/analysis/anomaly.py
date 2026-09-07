"""ML-based anomaly detection, Python-exclusive.

`detect_ml_anomalies` (IsolationForest-based) has no TypeScript/core
equivalent anywhere in `packages/`. See the "Anomaly detection: Node vs
Python" section of the root README for the full comparison.
"""

from __future__ import annotations

from typing import TypedDict

from ..events import Event
from .stats import (
    BaselineStats,
    DeviationSeverity,
    classify_severity,
    compute_baseline_stats,
    z_score_of,
)


class MLAnomalyResult(TypedDict):
    event_id: str
    service: str
    anomaly_score: float
    z_score: float
    severity: DeviationSeverity
    is_anomalous: bool


DEFAULT_CONTAMINATION = 0.1
DEFAULT_MIN_SAMPLES = 10
DEFAULT_RANDOM_STATE = 0


def _feature_vector(event: Event) -> list[float]:
    duration = event.duration_ms if event.duration_ms is not None else 0.0
    is_error = 1.0 if event.severity in ("error", "critical") else 0.0
    return [duration, is_error]


def detect_ml_anomalies(
    events: list[Event],
    service: str,
    contamination: float = DEFAULT_CONTAMINATION,
    min_samples: int = DEFAULT_MIN_SAMPLES,
    random_state: int = DEFAULT_RANDOM_STATE,
    low_threshold: float = 1.0,
    medium_threshold: float = 2.0,
    high_threshold: float = 3.0
) -> list[MLAnomalyResult]:
    try:
        from sklearn.ensemble import IsolationForest
    except ImportError as exc:
        raise ImportError(
            "detect_ml_anomalies requires the 'analysis' extra: "
            "pip install obyflow-python[analysis]"
        ) from exc

    service_events = [e for e in events if e.service == service]
    if len(service_events) < min_samples:
        return []

    features = [_feature_vector(e) for e in service_events]
    model = IsolationForest(contamination=contamination, random_state=random_state)
    model.fit(features)
    raw_scores = model.decision_function(features)
    predictions = model.predict(features)

    baseline: BaselineStats = compute_baseline_stats([float(s) for s in raw_scores])

    results: list[MLAnomalyResult] = []
    for event, score, prediction in zip(service_events, raw_scores, predictions):
        z_score = z_score_of(float(score), baseline)
        results.append(
            {
                "event_id": event.id,
                "service": service,
                "anomaly_score": float(score),
                "z_score": z_score,
                "severity": classify_severity(
                    z_score, low_threshold, medium_threshold, high_threshold
                ),
                "is_anomalous": bool(prediction == -1),
            }
        )
    return results
