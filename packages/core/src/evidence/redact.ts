import { Event } from "../event-model/event.schema.js";

export interface RedactionConfig {
  enabled: boolean;
  fields: string[];
  applied_at: "ingestion" | "evidence";
}

export const DEFAULT_REDACTION_CONFIG: RedactionConfig = {
  enabled: true,
  fields: ["password", "token", "authorization", "creditcard", "ssn", "apikey"],
  applied_at: "ingestion",
};

const REDACTED_PLACEHOLDER = "[REDACTED]";

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Minimum normalized-key length required to match via the reverse
// (field-contains-key) direction. Without this floor, very short keys
// like "t" or "s" spuriously match long field names like "token" or
// "ssn" purely because they're single-character substrings.
const MIN_REVERSE_MATCH_LENGTH = 4;

function keyMatchesField(key: string, fields: string[]): boolean {
  const normalizedKey = normalizeKey(key);
  if (normalizedKey.length === 0) return false;
  return fields.some((field) => {
    const normalizedField = normalizeKey(field);
    if (normalizedField.length === 0) return false;
    if (normalizedKey.includes(normalizedField)) return true;
    if (normalizedKey.length < MIN_REVERSE_MATCH_LENGTH) return false;
    return normalizedField.includes(normalizedKey);
  });
}

function luhnCheck(digits: string): boolean {
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

function looksLikeCreditCard(value: string): boolean {
  const trimmed = value.trim();
  if (!/^(?:\d[ -]?){13,19}$/.test(trimmed)) return false;
  const digits = trimmed.replace(/[ -]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  return luhnCheck(digits);
}

function looksLikeSsn(value: string): boolean {
  return /^\d{3}-\d{2}-\d{4}$/.test(value.trim());
}

function looksLikeBearerToken(value: string): boolean {
  return /^Bearer\s+\S{10,}$/i.test(value.trim());
}

function valueLooksSensitive(value: string): boolean {
  return (
    looksLikeCreditCard(value) ||
    looksLikeSsn(value) ||
    looksLikeBearerToken(value)
  );
}

function redactValue(key: string, value: unknown, fields: string[]): unknown {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(key, item, fields));
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      result[childKey] = redactValue(childKey, childValue, fields);
    }
    return result;
  }

  if (typeof value === "string") {
    if (keyMatchesField(key, fields)) return REDACTED_PLACEHOLDER;
    if (valueLooksSensitive(value)) return REDACTED_PLACEHOLDER;
  }

  return value;
}

export function redactAttributes(
  attributes: Record<string, unknown>,
  config: RedactionConfig = DEFAULT_REDACTION_CONFIG,
): Record<string, unknown> {
  if (!config.enabled) return attributes;
  return redactValue("", attributes, config.fields) as Record<
    string,
    unknown
  >;
}

export function redactEvent(
  event: Event,
  config: RedactionConfig = DEFAULT_REDACTION_CONFIG,
): Event {
  if (!config.enabled) return event;
  return {
    ...event,
    attributes: redactAttributes(event.attributes, config),
  };
}