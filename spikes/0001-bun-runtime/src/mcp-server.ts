// Tiny stdio MCP server used by the SDK check (ADR-0001 spike, check 4).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "spike-echo", version: "0.0.1" });
server.registerTool(
  "echo",
  { description: "Echo text back", inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
);
await server.connect(new StdioServerTransport());
