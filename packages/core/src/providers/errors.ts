// Maps HTTP failures from any adapter onto the error taxonomy in ADR-0002.
import { ProviderError } from "../types";

const LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  chatgpt: "ChatGPT",
};

export function mapHttpError(provider: string, status: number | undefined, message: string): ProviderError {
  const who = LABEL[provider] ?? provider;
  const text = `${who} ${status ?? ""}: ${message}`.replace(/\s+/g, " ").trim();
  if (status === 401 || status === 403)
    return new ProviderError(
      "auth",
      text,
      provider === "chatgpt" ? "run `teh login chatgpt` again" : "check the API key in your environment",
    );
  if (status === 429) {
    if (/usage_limit|quota|insufficient/i.test(message))
      return new ProviderError(
        "rate_limited",
        text,
        provider === "chatgpt" ? "plan limit reached; Manage usage: https://chatgpt.com/settings/usage" : undefined,
      );
    return new ProviderError("rate_limited", text, "wait a moment and try again");
  }
  if (status === 529 || status === 503 || (status !== undefined && status >= 500))
    return new ProviderError("overloaded", text, "the service is busy; try again shortly");
  if (
    status === 413 ||
    /prompt is too long|context.length|context_length_exceeded|maximum context|too many tokens/i.test(message)
  )
    return new ProviderError("context_exceeded", text);
  return new ProviderError("bad_request", text);
}
