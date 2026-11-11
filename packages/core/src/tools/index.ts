import { bashTool } from "./bash";
import { editTool, mtime, readTool, requireFreshRead, writeTool } from "./files";
import { notebookEditTool } from "./notebook";
import { exitPlanModeTool } from "./plan";
import { globTool, grepTool } from "./search";
import { bashOutputTool, killShellTool } from "./shells";
import { todoWriteTool } from "./todo";
import type { Tool } from "./tool";
import { webFetchTool, webSearchTool } from "./web";

export * from "./media";
export * from "./notebook";
export * from "./plan";
export * from "./shells";
export * from "./skill";
export * from "./task";
export * from "./todo";
export * from "./tool";
export * from "./web";

// Built-in tools, named as in Claude Code (ADR-0010).
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool argument types
export const builtinTools: Tool<any>[] = [
  readTool,
  globTool,
  grepTool,
  editTool,
  writeTool,
  notebookEditTool(requireFreshRead, mtime),
  bashTool,
  bashOutputTool,
  killShellTool,
  todoWriteTool,
  exitPlanModeTool,
  webFetchTool,
  webSearchTool,
];
