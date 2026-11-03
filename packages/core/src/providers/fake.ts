// Scripted provider for tests: each call to stream() plays the next turn.
import type { ModelRequest, StreamEvent } from "../types";
import type { ModelInfo, ProbeResult, Provider } from "./provider";

export type FakeTurn = StreamEvent[] | ((req: ModelRequest) => StreamEvent[]);

export class FakeProvider implements Provider {
  readonly id = "fake";
  readonly requests: ModelRequest[] = [];
  private next = 0;

  constructor(private readonly turns: FakeTurn[]) {}

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "fake", supportsTools: true, contextWindow: 200_000 }];
  }

  async probe(): Promise<ProbeResult> {
    return { supportsTools: true, contextWindow: 200_000, notes: [] };
  }

  async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    this.requests.push(structuredClone(req));
    const turn = this.turns[this.next++];
    if (!turn) throw new Error(`FakeProvider: no scripted turn ${this.next}`);
    for (const event of typeof turn === "function" ? turn(req) : turn) yield event;
  }
}

// Helpers for building scripted turns.
export const say = (text: string): StreamEvent[] => [
  { type: "text_delta", text },
  { type: "usage", usage: { input: 10, cachedRead: 0, cacheWrite: 0, output: 5 } },
  { type: "stop", reason: "end" },
];

export const callTool = (name: string, args: unknown, id = `call_${name}`): StreamEvent[] => [
  { type: "tool_call", id, name, args },
  { type: "stop", reason: "tool_use" },
];
