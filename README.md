# Obyflow

**AI-native, CLI-first observability platform** for tracing, debugging, and understanding modern applications — LLM calls, vector-store queries, and framework (LangChain) steps included.

Obyflow captures structured events locally (SQLite, no external backend required), correlates them into traces, and uses an LLM of your choice to turn raw evidence into a plain-English investigation of what went wrong.

[![npm version](https://img.shields.io/npm/v/obyflow.svg)](https://www.npmjs.com/package/obyflow)
[![PyPI version](https://img.shields.io/pypi/v/obyflow-python.svg)](https://pypi.org/project/obyflow-python/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

If you find Obyflow useful, please consider ⭐ starring the repo — it helps others discover the project.

![Obyflow interactive terminal](./docs/obyflow-terminal.png)

## Install

```bash
npm install -g obyflow          # CLI - https://www.npmjs.com/package/obyflow
npm install @obyflow/node       # Node.js SDK - https://www.npmjs.com/package/@obyflow/node
pip install obyflow-python      # Python SDK - https://pypi.org/project/obyflow-python/
```

## Features

- **Structured event model** — 10 typed event kinds (`trace`, `log`, `metric`, `error`, `embedding`, `vector_op`, `chain`, `tool_call`, `llm_call`, `custom`), each with typed attributes (e.g. `llm_call` captures model/provider/token counts/latency; `vector_op` captures db provider, similarity scores, result counts)
- **Trace correlation** — joins events by trace/span/request id into a single correlated trace; the Node and Python SDKs auto-propagate `x-obyflow-trace-id`/`x-obyflow-parent-span-id` headers across outbound HTTP/fetch calls, so multi-service traces stay linked with zero manual header wiring
- **Anomaly detection** — statistical baselining (mean/stddev and median/MAD) with z-scored deviations against historical norms
- **Evidence graph & diagnosis engines** — purpose-built diagnosis for LangChain/LangGraph/LlamaIndex chain failures (failed steps, tool-call timeouts, empty retriever results, step-duration regressions) and vector-DB retrieval issues (empty results, low similarity, slow queries, embedding latency)
- **"What changed" correlation** — correlates incidents against deployments, git commits, config changes, feature flags, model version changes, and dependency changes; git correlation reads real commit metadata (author, files changed, insertions/deletions) from a local repo
- **Confidence scoring** — HIGH/MEDIUM/LOW investigation confidence based on evidence volume, anomaly severity, correlated services, and deployment correlation
- **Incident memory** — fingerprints incidents and surfaces similar past incidents, learning from recorded resolutions over time
- **Telemetry health checks** — detects dropped events and coverage gaps in your instrumentation
- **AI-assisted investigation** — ask a question or investigate a trace, get an evidence-backed root-cause summary, with grounding validation (flags LLM citations that don't match real evidence) and token-budget-aware context trimming
- **Token usage & cost tracking** — per-request prompt/completion token counts on every `llm_call` event, rolled up by the `usage` command into per-service totals and estimated USD cost via built-in pricing tables (Claude, GPT-4o/5, Gemini); also tracks per-model context-window limits and warns when investigation context is approaching a model's limit
- **Resilient LLM calls** — automatic retry with exponential backoff on rate limits (429), overloaded/unavailable errors (503), and transient network failures (`ECONNRESET`/`ETIMEDOUT`/`ECONNREFUSED`)
- **Local-first storage** via SQLite, zero external infra to get started
- **Redaction** — configurable field-level redaction (passwords, tokens, credit cards, SSNs, API keys) applied at ingestion or evidence time, plus value-pattern detection (Luhn-validated credit card numbers, SSN format, bearer tokens) that redacts sensitive-looking values even when the field name doesn't match a configured field
- **Automatic resource attributes** — every emitted event is tagged with hostname, PID, and Node/Python runtime version, plus the current git commit SHA (read from CI env vars like `GITHUB_SHA`/`VERCEL_GIT_COMMIT_SHA` or a local `git rev-parse HEAD`) — this is what powers commit-based "what changed" correlation without any manual instrumentation
- **Pluggable LLM providers** — Anthropic, OpenAI, Gemini, Ollama, or none (evidence-only mode)
- **Node.js and Python SDKs** with matching instrumentation for LangChain and six vector databases (Pinecone, Qdrant, Weaviate, Chroma, pgvector, Milvus) plus embedding calls (OpenAI, Anthropic, Cohere). Inbound HTTP tracing differs by design: Node auto-instruments any `http`-based server (Express, Koa, Fastify, raw `http.createServer`) via a runtime patch installed by `start()`, with zero extra code; Python requires explicit middleware registration — `ObyflowASGIMiddleware` for FastAPI/Starlette or `ObyflowWSGIMiddleware` for Flask/Django (sync) — added once alongside `start()`.
- **Data export** — JSON, CSV, or OpenTelemetry OTLP
- **Live-updating CLI views** — `traces`/`logs`/`metrics`/`errors` support `--watch [seconds]` to poll and re-render, plus `--detail` for full detail cards instead of a table

## Repository layout

```
packages/
  core/                   shared event model, storage, config, evidence & anomaly logic
  cli/                    the `obyflow` CLI (init, start, traces, logs, investigate, ask, incident, ...)
  node-sdk/               @obyflow/node — instrumentation SDK for Node.js apps
  adapters/
    adapter-framework/    LangChain callback handler adapter
    adapter-vectordb/     Pinecone / Qdrant / Weaviate / Chroma / pgvector / Milvus adapters
  llm/
    llm-core/             shared LLM adapter interface
    llm-anthropic/ llm-openai/ llm-gemini/ llm-ollama/
python/
  obyflow-python/         Python SDK (ASGI middleware, LangChain callback, vector/analysis helpers)
```

This is a pnpm + Turborepo monorepo for the TypeScript packages, plus a standalone Python package.

## Getting started

### Prerequisites

- Node.js ≥ 22 (CI targets 24) and [pnpm](https://pnpm.io) 10.x
- A C/C++ toolchain and Python 3 (needed to compile the `better-sqlite3` native addon — most Linux/macOS setups already have these; on Debian/Ubuntu: `apt install build-essential python3`)
- Python ≥ 3.9 (only if you're using the Python SDK)

### Install & build

```bash
git clone https://github.com/Obyflow/obyflow.git
cd obyflow
pnpm install
pnpm build     # builds every package in dependency order (via turbo)
pnpm test      # runs every package's test suite
```

### Use the CLI

```bash
# from inside your project
npx obyflow init                                # detect the project, write obyflow.config.json
npx obyflow start                                # initialize local SQLite storage
npx obyflow config llm --provider anthropic      # pick an LLM provider for investigations
npx obyflow traces                               # list recent traces
npx obyflow logs                                 # list log events
npx obyflow metrics                              # list metric events
npx obyflow errors                               # list error/critical severity events
npx obyflow services                             # list observed services with event/error counts
npx obyflow usage                                # summarize LLM token consumption and estimated cost by service
npx obyflow investigate <traceId>                # AI-assisted root-cause investigation
npx obyflow investigate --since 1h               # investigate the worst incident in a time window
npx obyflow investigate --since 1h --db obyflow.db # investigate against a specific database file
npx obyflow ask "why did checkout fail today?"
npx obyflow incident summarize                   # summarize the most severe incidents in a time window
npx obyflow incident resolve <traceId> --status resolved   # record how an incident was actually resolved
npx obyflow export --format csv --out events.csv # export events as JSON, CSV, or OTLP
npx obyflow prune --older-than 30d --yes          # delete events older than an age threshold
npx obyflow config list                          # show the current config
npx obyflow config get llm.provider              # read a single config value
npx obyflow config set llm.model <model-id>      # set and persist a config value
```

The read commands (`traces`, `logs`, `metrics`, `errors`, `usage`, `export`) accept `--db <path>` (defaults to `obyflow.db`), `--service <name>`, and `--since <window>` (e.g. `15m`, `2h`, `1d`) to scope results; `traces`, `logs`, `metrics`, and `errors` additionally support `--limit <n>`, `--detail` (full detail cards instead of a table), and `--watch [seconds]` (poll and re-render, default every 2s). `investigate` and `incident summarize` accept `--git-repo <path>` to correlate incidents against real commit metadata (author, files changed, insertions/deletions) from a local git repository, and `--no-llm` to show evidence and anomalies only, skipping LLM synthesis. Run `npx obyflow <command> --help` for the full flag list on any command.

Supported LLM providers: `anthropic`, `openai`, `gemini`, `ollama`, or `none` (evidence-only mode, no LLM key required).

Example using Gemini:

```bash
npx obyflow config llm --provider gemini
export GEMINI_API_KEY=<your-api-key>
```

### Instrument a Node.js app

```ts
import { start } from "@obyflow/node";

const obyflow = start({ service: "checkout-api" });

// Inbound AND outbound HTTP are both instrumented automatically by start();
// wrap LangChain, vector-db clients, and embedding clients explicitly as needed
const pineconeIndex = obyflow.instrument.pinecone(index);
const langchainHandler = obyflow.instrument.langchain();
```

The SDK also exports the same instrumentation helpers directly if you'd rather not go through `obyflow.instrument.*` (`instrumentOutboundHttp`, `instrumentLangChain`, `instrumentPinecone`/`Qdrant`/`Weaviate`/`Chroma`/`PgVector`/`Milvus`, `instrumentOpenAIEmbeddings`/`AnthropicEmbeddings`/`CohereEmbeddings`) plus trace-context helpers (`runWithTraceContext`, `getActiveTraceId`) for manual instrumentation.

### Instrument a Python app

```python
from obyflow import start
from obyflow.instrumentation.asgi import ObyflowASGIMiddleware

handle = start(service="checkout-api")
app.add_middleware(ObyflowASGIMiddleware, service="checkout-api", store=handle.store)
```

`start()` auto-instruments outbound HTTP; the Python SDK also ships `instrumentation/langchain.py` and `instrumentation/vectordb.py` for LangChain and vector-db instrumentation, a Python-only `analysis/` module (`anomaly.py`, `stats.py`, see "Anomaly detection: Node vs Python" below), and `redaction.py` for scrubbing sensitive fields before they're stored.

## Anomaly detection: Node vs Python

| Capability | Node/CLI (`packages/core`) | Python (`obyflow.analysis`) |
|---|---|---|
| Mean/stddev baselining | Yes | Yes |
| Median/MAD ("robust") baselining | Yes | No |
| Rolling time-windowed buckets | Yes | No |
| Deployment-aware bucketing | Yes | No |
| Configurable z-score threshold | Yes | Yes |
| ML-based detection (IsolationForest) | No | Yes (`detect_ml_anomalies`, `obyflow-python[analysis]`) |

The Python SDK's `analysis/` module is a separate, Python-only convenience toolkit, not a port of `packages/core/src/anomaly/baseline.ts`, which the CLI's `investigate`/`ask`/`incident` commands use internally. `detect_ml_anomalies` (IsolationForest-based) is Python-exclusive, with no TypeScript/core equivalent.

## Development

```bash
pnpm install       # install all workspace dependencies
pnpm build         # turbo run build (respects package dependency order)
pnpm test          # turbo run test
pnpm --filter @obyflow/core test   # test a single package
```

Python SDK:

```bash
cd python/obyflow-python
pip install -e ".[dev]"
pytest
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow, coding conventions, and how to submit a pull request.

## Versioning

`@obyflow/node` and `obyflow-python` are versioned independently and are not required to share a version number. Compatibility between them is defined by the event schema and instrumentation contract they implement, not by matching package versions.

| SDK | Package | Current version |
|---|---|---|
| Node.js | `@obyflow/node` | see `packages/node-sdk/package.json` |
| Python | `obyflow-python` | see `python/obyflow-python/pyproject.toml` |

Any change to the shared event schema, redaction rules, or resource-attribute detection must be applied to both SDKs (see "Cross-SDK parity" in [CONTRIBUTING.md](./CONTRIBUTING.md#cross-sdk-parity)) regardless of their individual version numbers.

## License

[MIT](./LICENSE) © Anupam Kumar
