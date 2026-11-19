# Cost and tracing

## What runs cost
Every run is added to `~/.teh/usage.jsonl`: the time, session id, the project folder's name, the model, who paid (API key, ChatGPT plan, or local), tokens, and the cost at list prices. Nothing in it leaves your machine.

```bash
teh usage            # the last 30 days, by day and by model
teh usage --days 7
```
Costs are list prices from the bundled model registry ([providers](providers.md)). Local models and the ChatGPT plan count as $0, and models without a known price are shown as "unpriced". During a session, `/usage` shows the same numbers for that session.

## Traces
`teh` can send OpenTelemetry traces, using the [GenAI conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/), to your own collector, such as Jaeger, Langfuse, Phoenix, Honeycomb or Datadog. It is off unless you set one of these:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318        # sends to …/v1/traces
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://host/v1/traces # or the full URL
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer%20…"   # optional
export TEH_TRACE_FILE=~/teh-trace.jsonl                         # or spans as JSON lines
```
`OTEL_SDK_DISABLED=true` turns it off again.

Each run is one trace: `invoke_agent teh`, and under it a `chat <model>` span per model request (tokens, cached tokens, finish reason) and an `execute_tool <name>` span per tool call (marked as an error when the tool failed). Spans hold model names, token counts, tool names, timings and outcomes. They **never** hold your prompts, the model's replies, tool arguments or output, or file paths.

These traces are separate from the project's own usage statistics ([ADR-0011](../adr/0011-telemetry.md)); see [ADR-0023](../adr/0023-measurement.md).
