import pytest

from obyflow.analysis.stats import (
    classify_severity,
    compute_baseline_stats,
    mean,
    stddev,
    z_score_of,
)


def test_mean_and_stddev_of_empty_list():
    assert mean([]) == 0.0
    assert stddev([]) == 0.0


def test_compute_baseline_stats():
    stats = compute_baseline_stats([10.0, 20.0, 30.0])
    assert stats["mean"] == 20.0
    assert stats["count"] == 3
    assert stats["stddev"] > 0


def test_z_score_of_zero_stddev_equal_value():
    baseline = {"mean": 5.0, "stddev": 0.0, "count": 3}
    assert z_score_of(5.0, baseline) == 0.0


def test_z_score_of_zero_stddev_higher_value():
    baseline = {"mean": 5.0, "stddev": 0.0, "count": 3}
    assert z_score_of(10.0, baseline) == 10.0


def test_z_score_of_zero_stddev_lower_value():
    baseline = {"mean": 5.0, "stddev": 0.0, "count": 3}
    assert z_score_of(1.0, baseline) == -10.0


def test_z_score_of_nonzero_stddev():
    baseline = {"mean": 10.0, "stddev": 2.0, "count": 5}
    assert z_score_of(14.0, baseline) == 2.0


def test_classify_severity_tiers():
    assert classify_severity(0.5) == "none"
    assert classify_severity(1.5) == "low"
    assert classify_severity(2.5) == "medium"
    assert classify_severity(4.0) == "high"
    assert classify_severity(-4.0) == "high"


def test_classify_severity_custom_thresholds():
    assert classify_severity(1.5, low_threshold=2.0, medium_threshold=3.0, high_threshold=4.0) == "none"
    assert classify_severity(2.5, low_threshold=2.0, medium_threshold=3.0, high_threshold=4.0) == "low"
    assert classify_severity(3.5, low_threshold=2.0, medium_threshold=3.0, high_threshold=5.0) == "medium"
    assert classify_severity(5.5, low_threshold=2.0, medium_threshold=3.0, high_threshold=5.0) == "high"


def test_classify_severity_raises_on_invalid_threshold_order():
    with pytest.raises(ValueError):
        classify_severity(1.0, low_threshold=5.0, medium_threshold=1.0, high_threshold=3.0)