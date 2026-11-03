// Canonical, provider-neutral conversation model (ADR-0002).

export type Role = "user" | "assistant";

export type Item =
  | { kind: "text"; role: Role; text: string }
  | { kind: "tool_call"; id: string; name: string; args: unknown }
  | { kind: "tool_result"; callId: string; name: string; content: string; isError?: boolean }
  // Opaque provider reasoning. Replayed only to the provider that produced it.
  | { kind: "reasoning"; provider: string; text?: string; opaque?: unknown };

export type JsonSchema = Record<string, unknown>;

export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
};

export type ModelRequest = {
  model: string;
  system: string;
  items: Item[];
  tools: ToolSpec[];
  maxOutputTokens?: number;
};

export type Usage = { input: number; cachedRead: number; cacheWrite: number; output: number };

export type StopReason = "end" | "tool_use" | "max_tokens" | "refusal" | "error";

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "usage"; usage: Usage }
  | { type: "stop"; reason: StopReason };

export type ErrorKind =
  | "rate_limited"
  | "overloaded"
  | "context_exceeded"
  | "content_filtered"
  | "auth"
  | "bad_request"
  | "unavailable";

// Every adapter maps its failures onto this taxonomy (ADR-0002).
export class ProviderError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export const emptyUsage = (): Usage => ({ input: 0, cachedRead: 0, cacheWrite: 0, output: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    cachedRead: a.cachedRead + b.cachedRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
  };
}
