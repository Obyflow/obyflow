import type { EvidenceObject } from "@obyflow/core";
import {
  LLMConfigError,
  resolveConfigValue,
  resolveNumberConfigValue,
  estimateTokenCount,
  normalizeUsage,
  getContextLimit,
  buildTokenWarning,
  estimateCostUsd,
  withRetry,
  validateEvidenceGrounding,
  trimEvidenceForContext,
} from "@obyflow/llm-core";
import type {
  LLMAdapter,
  LLMAdapterConfig,
  LLMInvestigationResult,
} from "@obyflow/llm-core";

const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_TEMPERATURE = 0;

const FINDING_TOOL_NAME = "submit_investigation_finding";

const FINDING_TOOL = {
  type: "function",
  function: {
    name: FINDING_TOOL_NAME,
    description:
      "Submit the structured root-cause investigation finding derived strictly from the provided evidence object.",
    parameters: {
      type: "object",
      properties: {
        root_cause: {
          type: "string",
          description:
            "A concise explanation of the most likely root cause, grounded only in the supplied evidence.",
        },
        evidence_refs: {
          type: "array",
          items: { type: "string" },
          description:
            "IDs of evidence items (from the evidence array) that support the root cause.",
        },
        recommendation: {
          type: "string",
          description:
            "A concrete, actionable recommendation to resolve or mitigate the issue.",
        },
      },
      required: ["root_cause", "evidence_refs", "recommendation"],
    },
  },
};

function buildSystemPrompt(): string {
  return [
    "You are the investigation engine inside Obyflow, an observability platform.",
    "You are given a structured Evidence Object containing correlated trace, log, metric, and error data along with computed anomaly scores.",
    "The evidence_graph field contains CALLED/FAILED/CAUSED/AFFECTED edges between evidence items; prefer root causes supported by CAUSED or FAILED edges over coincidental timing.",
    "The what_changed field lists deployment changes detected near the incident window, ranked by relevance_score; treat a high-ranked entry as a likely root cause candidate when it correlates with the anomalies.",
    "When a what_changed entry has a git field, it is real commit metadata (author, subject, files changed) for that commit-type change; use it to explain what code actually changed, never as a standalone root cause.",
    "The similar_historical_incidents field lists prior incidents with overlapping fingerprints (shared services, anomaly types, change types, or error signatures); use them only as corroborating context, never as the primary basis for a root cause.",
    "Ground every claim strictly in the supplied evidence. Do not invent services, timestamps, or values that are not present in the evidence object.",
    "Reference evidence items by their id field in evidence_refs.",
    "Do not compute or state a confidence level; that is handled outside of you.",
    "You must respond only by calling the submit_investigation_finding tool with a single JSON object; do not include any other text.",
  ].join(" ");
}

function buildUserPrompt(evidence: EvidenceObject, question?: string): string {
  return [
    question
      ? `Investigation question: ${question}`
      : "Investigate this trace and determine the most likely root cause.",
    "Evidence Object (JSON):",
    JSON.stringify(evidence, null, 2),
  ].join("\n\n");
}

interface RawFinding {
  root_cause?: unknown;
  evidence_refs?: unknown;
  recommendation?: unknown;
}

function isValidFinding(
  finding: RawFinding,
): finding is { root_cause: string; evidence_refs: unknown[]; recommendation: string } {
  return (
    typeof finding.root_cause === "string" &&
    typeof finding.recommendation === "string" &&
    Array.isArray(finding.evidence_refs)
  );
}

interface OllamaToolCall {
  function?: { name?: string; arguments?: unknown };
}

interface OllamaChatResponse {
  message?: {
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
  prompt_eval_count?: number;
  eval_count?: number;
}

function extractFinding(response: OllamaChatResponse): RawFinding | null {
  const toolCall = response.message?.tool_calls?.find(
    (call) => call.function?.name === FINDING_TOOL_NAME,
  );

  if (toolCall?.function?.arguments !== undefined) {
    const args = toolCall.function.arguments;
    return typeof args === "string" ? (JSON.parse(args) as RawFinding) : (args as RawFinding);
  }

  const content = response.message?.content;
  if (!content) {
    return null;
  }
  try {
    return JSON.parse(content) as RawFinding;
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as RawFinding;
      } catch {
        return null;
      }
    }
    return null;
  }
}

export class OllamaLLMAdapter implements LLMAdapter {
  readonly provider = "ollama";
  readonly model: string;

  private readonly baseUrl: string;
  private readonly temperature: number;

  constructor(config: LLMAdapterConfig = {}) {
    const model = resolveConfigValue(config.model, "OBYFLOW_OLLAMA_MODEL");
    if (!model) {
      throw new LLMConfigError(
        "Missing Ollama model. Pass model to OllamaLLMAdapter or set OBYFLOW_OLLAMA_MODEL.",
      );
    }
    this.model = model;
    this.baseUrl =
      resolveConfigValue(config.baseUrl, "OBYFLOW_OLLAMA_BASE_URL") ?? DEFAULT_BASE_URL;
    this.temperature =
      resolveNumberConfigValue(config.temperature, "OBYFLOW_OLLAMA_TEMPERATURE") ??
      DEFAULT_TEMPERATURE;
  }

  async investigate(
    evidence: EvidenceObject,
    question?: string,
  ): Promise<LLMInvestigationResult> {
    const requestedAt = new Date().toISOString();
    const startedAt = Date.now();

    const contextLimit = getContextLimit(this.provider, this.model);
    const { evidence: trimmedEvidence, trim } = trimEvidenceForContext(evidence, contextLimit);

    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(trimmedEvidence, question);

    const callOllama = async (body: Record<string, unknown>) => {
      const res = await withRetry(async () => {
        const r = await fetch(`${this.baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const error = new Error(`Ollama request failed with status ${r.status}`) as Error & {
            status?: number;
          };
          error.status = r.status;
          throw error;
        }
        return r;
      });
      return (await res.json()) as OllamaChatResponse;
    };

    let payload = await callOllama({
      model: this.model,
      stream: false,
      options: { temperature: this.temperature },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      tools: [FINDING_TOOL],
    });

    let finding = extractFinding(payload);
    if (!finding || !isValidFinding(finding)) {
      const jsonSchemaReminder = [
        "Your previous response did not call the required tool.",
        "Respond now with ONLY a single JSON object (no prose, no markdown fences) matching exactly this shape:",
        '{"root_cause": string, "evidence_refs": string[], "recommendation": string}',
      ].join(" ");

      payload = await callOllama({
        model: this.model,
        stream: false,
        format: "json",
        options: { temperature: this.temperature },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
          { role: "user", content: jsonSchemaReminder },
        ],
      });

      finding = extractFinding(payload);
    }

    const latencyMs = Date.now() - startedAt;

    if (!finding || !isValidFinding(finding)) {
      throw new Error(
        "Ollama response did not match the expected investigation finding shape, even after a forced-JSON retry. Try a model with more reliable instruction-following.",
      );
    }

    const evidenceRefs = finding.evidence_refs.filter(
      (ref): ref is string => typeof ref === "string",
    );

    const inputTokens =
      payload.prompt_eval_count ?? estimateTokenCount(systemPrompt + userPrompt);
    const outputTokens =
      payload.eval_count ?? estimateTokenCount(payload.message?.content ?? "");
    const usage = normalizeUsage(inputTokens, outputTokens);
    const tokenWarning = buildTokenWarning(usage, contextLimit);
    const estimatedCostUsd = estimateCostUsd(usage, this.model);
    const grounding = validateEvidenceGrounding(evidence, evidenceRefs);
    const contextTrim =
      trim.trimmed_evidence_items + trim.trimmed_what_changed + trim.trimmed_similar_incidents > 0
        ? trim
        : null;

    return {
      root_cause: finding.root_cause,
      evidence_refs: evidenceRefs,
      recommendation: finding.recommendation,
      provider: this.provider,
      model: this.model,
      requested_at: requestedAt,
      latency_ms: latencyMs,
      raw_response: JSON.stringify(payload.message ?? {}),
      usage,
      context_limit: contextLimit,
      token_warning: tokenWarning,
      estimated_cost_usd: estimatedCostUsd,
      grounded_evidence_refs: grounding.grounded_evidence_refs,
      ungrounded_evidence_refs: grounding.ungrounded_evidence_refs,
      groundedness_warning: grounding.groundedness_warning,
      context_trim: contextTrim,
    };
  }
}
