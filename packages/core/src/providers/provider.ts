import type { ModelRequest, StreamEvent } from "../types";
import type { AuthRoute } from "./registry";

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
  // Whether the model accepts images.
  vision?: boolean;
  notes: string[];
};

export interface Provider {
  readonly id: string;
  // How its tokens are paid for (ADR-0002); shown in the status line (ADR-0009).
  readonly route: AuthRoute;
  listModels(): Promise<ModelInfo[]>;
  probe(model: string): Promise<ProbeResult>;
  stream(req: ModelRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
  // Text embeddings, for providers that offer them (used by the skill router, ADR-0015).
  embed?(model: string, inputs: string[]): Promise<number[][]>;
}
