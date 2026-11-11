import { bashTool } from "./bash";
import { editTool, readTool, writeTool } from "./files";
import { globTool, grepTool } from "./search";
import type { Tool } from "./tool";

export * from "./skill";
export * from "./task";
export * from "./tool";

// Built-in tools, named as in Claude Code (ADR-0010).
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool argument types
export const builtinTools: Tool<any>[] = [readTool, globTool, grepTool, editTool, writeTool, bashTool];
