import builtins
from datetime import datetime, timezone
from unittest.mock import patch

import pytest

from obyflow.analysis.anomaly import detect_ml_anomalies
from obyflow.events import Event


def _events(count, service):
    return [
        Event(
            id=f"e{i}", type="trace", trace_id=None, request_id=None,
            service=service, host=None, container=None, deployment_id=None,
            timestamp=datetime.now(timezone.utc).isoformat(),
            duration_ms=100.0 + i, attributes={}, severity=None,
        )
        for i in range(count)
    ]


@pytest.mark.parametrize("count,service", [(0, "checkout"), (3, "checkout"),
                                          (20, "checkout"), (20, "other")])
@pytest.mark.parametrize("thresholds", [(5.0, 1.0, 3.0), (1.0, 1.0, 3.0),
                                       (1.0, 3.0, 3.0)])
def test_invalid_thresholds_fail_before_model_construction(count, service, thresholds):
    pytest.importorskip("sklearn")
    with patch("sklearn.ensemble.IsolationForest") as model:
        model.side_effect = AssertionError("Model constructed before threshold validation")
        with pytest.raises(ValueError, match="Thresholds must be in ascending order"):
            detect_ml_anomalies(
                _events(count, service), "checkout", min_samples=5,
                low_threshold=thresholds[0], medium_threshold=thresholds[1],
                high_threshold=thresholds[2],
            )
        model.assert_not_called()


@pytest.mark.parametrize("invalid", [True, False])
def test_threshold_validation_precedes_optional_dependency_import(invalid):
    original_import = builtins.__import__

    def without_sklearn(name, *args, **kwargs):
        if name == "sklearn" or name.startswith("sklearn."):
            raise ImportError("analysis extra is absent")
        return original_import(name, *args, **kwargs)

    with patch("builtins.__import__", side_effect=without_sklearn):
        if invalid:
            with pytest.raises(ValueError, match="Thresholds must be in ascending order"):
                detect_ml_anomalies([], "checkout", low_threshold=5.0)
        else:
            with pytest.raises(ImportError, match="requires the 'analysis' extra"):
                detect_ml_anomalies([], "checkout")
