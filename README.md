# Obyflow

**AI-native, CLI-first observability for modern applications.** Trace and debug LLM calls, vector-store queries, and LangChain steps from your terminal.

Obyflow stores structured events locally in SQLite, connects them into traces, and can use an LLM of your choice to help investigate what went wrong.

[![npm version](https://img.shields.io/npm/v/obyflow.svg)](https://www.npmjs.com/package/obyflow)
[![PyPI version](https://img.shields.io/pypi/v/obyflow-python.svg)](https://pypi.org/project/obyflow-python/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

If Obyflow is useful to you, consider giving the repo a ⭐.

![Obyflow interactive terminal](./docs/obyflow-terminal.png)

## Install

```bash
npm install -g obyflow          # CLI - https://www.npmjs.com/package/obyflow
npm install @obyflow/node       # Node.js SDK - https://www.npmjs.com/package/@obyflow/node
pip install obyflow-python      # Python SDK - https://pypi.org/project/obyflow-python/
```

## Features

- **Structured events** — Traces, logs, metrics, errors, LLM calls, tools, embeddings, vectors, chains, and custom events.
- **Distributed tracing** — Follow requests across services with automatic trace propagation.
- **Anomaly detection** — Spot unusual behavior against historical baselines.
- **Root-cause analysis** — Diagnose chain failures, tool timeouts, retriever issues, and slow vector queries.
- **Change tracking** — See what changed across deployments, commits, configs, flags, models, and dependencies.
- **Incident history** — Find similar incidents and recorded resolutions.
- **AI investigations** — Investigate traces and incidents using your telemetry as evidence.
- **LLM usage** — Track tokens, costs, context usage, and model limits.
- **Automatic retries** — Handle rate limits, temporary provider errors, and network failures.
- **Local-first** — Store everything in SQLite with no external backend.
- **Redaction** — Automatically remove sensitive values before they're stored.
- **Node.js & Python** — SDKs with LangChain, vector DB, and embedding integrations.
- **Export** — JSON, CSV, or OpenTelemetry OTLP.
- **CLI** — Browse, filter, watch, and inspect your telemetry from the terminal.


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

Supported LLM providers: `gemini`, `anthropic`, `openai`, `ollama`, or `none` (evidence-only mode, no LLM key required).

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
