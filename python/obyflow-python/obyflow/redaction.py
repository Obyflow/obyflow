from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List

from .events import Event

REDACTED_PLACEHOLDER = "[REDACTED]"

_NON_ALNUM = re.compile(r"[^a-z0-9]")
_CC_PATTERN = re.compile(r"^(?:\d[ -]?){13,19}$")
_SSN_PATTERN = re.compile(r"^\d{3}-\d{2}-\d{4}$")
_BEARER_PATTERN = re.compile(r"^Bearer\s+\S{10,}$", re.IGNORECASE)


def _default_fields() -> List[str]:
    return ["password", "token", "authorization", "creditcard", "ssn", "apikey"]


@dataclass
class RedactionConfig:
    enabled: bool = True
    fields: List[str] = field(default_factory=_default_fields)
    applied_at: str = "ingestion"


DEFAULT_REDACTION_CONFIG = RedactionConfig()


def _normalize_key(key: str) -> str:
    return _NON_ALNUM.sub("", key.lower())


# Minimum normalized-key length required to match via the reverse
# (field-contains-key) direction. Without this floor, very short keys
# like "t" or "s" spuriously match long field names like "token" or
# "ssn" purely because they're single-character substrings.
_MIN_REVERSE_MATCH_LENGTH = 4


def _key_matches_field(key: str, fields: List[str]) -> bool:
    normalized_key = _normalize_key(key)
    if not normalized_key:
        return False
    for candidate in fields:
        normalized_field = _normalize_key(candidate)
        if not normalized_field:
            continue
        if normalized_field in normalized_key:
            return True
        if len(normalized_key) < _MIN_REVERSE_MATCH_LENGTH:
            continue
        if normalized_key in normalized_field:
            return True
    return False


def _luhn_check(digits: str) -> bool:
    total = 0
    should_double = False
    for ch in reversed(digits):
        d = int(ch)
        if should_double:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        should_double = not should_double
    return total % 10 == 0


def _looks_like_credit_card(value: str) -> bool:
    trimmed = value.strip()
    if not _CC_PATTERN.match(trimmed):
        return False
    digits = re.sub(r"[ -]", "", trimmed)
    if len(digits) < 13 or len(digits) > 19:
        return False
    return _luhn_check(digits)


def _looks_like_ssn(value: str) -> bool:
    return bool(_SSN_PATTERN.match(value.strip()))


def _looks_like_bearer_token(value: str) -> bool:
    return bool(_BEARER_PATTERN.match(value.strip()))


def _value_looks_sensitive(value: str) -> bool:
    return (
        _looks_like_credit_card(value)
        or _looks_like_ssn(value)
        or _looks_like_bearer_token(value)
    )


def _redact_value(key: str, value: Any, fields: List[str]) -> Any:
    if value is None:
        return value
    if isinstance(value, list):
        return [_redact_value(key, item, fields) for item in value]
    if isinstance(value, dict):
        return {k: _redact_value(k, v, fields) for k, v in value.items()}
    if isinstance(value, str):
        if _key_matches_field(key, fields):
            return REDACTED_PLACEHOLDER
        if _value_looks_sensitive(value):
            return REDACTED_PLACEHOLDER
    return value


def redact_attributes(
    attributes: Dict[str, Any], config: RedactionConfig = DEFAULT_REDACTION_CONFIG
) -> Dict[str, Any]:
    if not config.enabled:
        return attributes
    return _redact_value("", attributes, config.fields)


def redact_event(event: Event, config: RedactionConfig = DEFAULT_REDACTION_CONFIG) -> Event:
    if not config.enabled:
        return event
    return event.model_copy(update={"attributes": redact_attributes(event.attributes, config)})
