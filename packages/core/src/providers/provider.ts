import type { ModelRequest, StreamEvent } from "../types";

export type ModelInfo = {
  id: string;
  contextWindow?: number;
  supportsTools?: boolean;
  // Size on disk, where the provider reports it: a rough stand-in for capability and cost.
  sizeBytes?: number;
};

export type ProbeResult = {
  supportsTools: boolean;
  // The context window the runtime will actually use for our requests.
  contextWindow?: number;
  notes: string[];
};

export interface Provider {
  readonly id: string;
  listModels(): Promise<ModelInfo[]>;
  probe(model: string): Promise<ProbeResult>;
  stream(req: ModelRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
  // Text embeddings, for providers that offer them (used by the skill router, ADR-0015).
  embed?(model: string, inputs: string[]): Promise<number[][]>;
}
