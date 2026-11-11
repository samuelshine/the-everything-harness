// Jupyter notebooks (ADR-0021): Read shows a notebook as its cells, with ids and outputs, and
// NotebookEdit replaces, inserts or deletes a cell (Claude Code's name and arguments, ADR-0010).
// Editing a notebook as raw JSON with Edit is error-prone; this keeps the file valid.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { display, obj, resolvePath, str, type Tool, type ToolContext, ToolInputError, truncate } from "./tool";

type Output = {
  output_type?: string;
  text?: string | string[];
  data?: Record<string, unknown>;
  ename?: string;
  evalue?: string;
};
type Cell = {
  id?: string;
  cell_type: "code" | "markdown" | "raw";
  source: string | string[];
  metadata?: Record<string, unknown>;
  outputs?: Output[];
  execution_count?: number | null;
};
type Notebook = {
  cells: Cell[];
  nbformat?: number;
  nbformat_minor?: number;
  metadata?: { language_info?: { name?: string } };
};

const OUTPUT_CHARS = 2000;
const joinText = (t: string | string[] | undefined) => (Array.isArray(t) ? t.join("") : (t ?? ""));

export function loadNotebook(path: string): Notebook {
  let nb: Notebook;
  try {
    nb = JSON.parse(readFileSync(path, "utf8")) as Notebook;
  } catch (e) {
    throw new Error(`not a valid notebook: ${(e as Error).message}`);
  }
  if (!nb || !Array.isArray(nb.cells)) throw new Error("not a valid notebook: no cells");
  return nb;
}

// The id a cell is known by: its own id (nbformat 4.5+), or "cell-N" by position.
export const cellId = (c: Cell, i: number) => c.id ?? `cell-${i}`;

function outputText(o: Output): string {
  if (o.output_type === "stream") return joinText(o.text);
  if (o.output_type === "error") return `${o.ename ?? "Error"}: ${o.evalue ?? ""}`;
  const data = o.data ?? {};
  if (typeof data["text/plain"] === "string" || Array.isArray(data["text/plain"]))
    return joinText(data["text/plain"] as string | string[]);
  const kinds = Object.keys(data);
  return kinds.length ? `[${kinds.join(", ")} output]` : "";
}

export function renderNotebook(nb: Notebook): string {
  const lang = nb.metadata?.language_info?.name ?? "python";
  const parts = nb.cells.map((c, i) => {
    const head = `<cell id="${cellId(c, i)}" type="${c.cell_type}"${c.cell_type === "code" ? ` language="${lang}"` : ""}>`;
    const outs = (c.outputs ?? []).map((o) => outputText(o).replace(/\n+$/, "")).filter((t) => t.trim());
    const out = outs.length ? `\n<outputs>\n${truncate(outs.join("\n").trimEnd(), OUTPUT_CHARS)}\n</outputs>` : "";
    return `${head}\n${joinText(c.source).trimEnd()}${out}\n</cell>`;
  });
  return parts.length ? parts.join("\n\n") : "(the notebook has no cells)";
}

function findCell(nb: Notebook, id: string): number {
  const exact = nb.cells.findIndex((c, i) => cellId(c, i) === id);
  if (exact >= 0) return exact;
  // A bare number is a 0-based position.
  if (/^\d+$/.test(id) && Number(id) < nb.cells.length) return Number(id);
  return -1;
}

// Source as Jupyter stores it: a list of lines, each but the last ending in "\n".
const toSource = (text: string) => text.split(/(?<=\n)/).filter((l, i, all) => l !== "" || i < all.length - 1);

type Mode = "replace" | "insert" | "delete";
type NotebookArgs = { path: string; cellId?: string; source: string; cellType?: "code" | "markdown"; mode: Mode };

export function notebookEditTool(
  requireFreshRead: (p: string, ctx: ToolContext) => string | undefined,
  mtime: (p: string) => number,
): Tool<NotebookArgs> {
  return {
    spec: {
      name: "NotebookEdit",
      description:
        "Edit a Jupyter notebook (.ipynb) by cell: replace a cell's source, insert a new cell after a given cell (or at the start when cell_id is omitted), or delete a cell. Read the notebook first to see cell ids. Replacing a code cell clears its outputs.",
      inputSchema: {
        type: "object",
        properties: {
          notebook_path: { type: "string", description: "Path to the .ipynb file" },
          cell_id: {
            type: "string",
            description: "The cell to edit, as Read shows it; for insert, the cell to insert after",
          },
          new_source: { type: "string", description: "The cell's new source (ignored for delete)" },
          cell_type: { type: "string", enum: ["code", "markdown"], description: "Required for insert" },
          edit_mode: { type: "string", enum: ["replace", "insert", "delete"], description: "Default replace" },
        },
        required: ["notebook_path", "new_source"],
      },
    },
    parse(raw) {
      const o = obj(raw);
      const mode = (str(o, "edit_mode", true) ?? "replace") as Mode;
      if (!["replace", "insert", "delete"].includes(mode))
        throw new ToolInputError('edit_mode must be "replace", "insert" or "delete"');
      const cellType = str(o, "cell_type", true);
      if (cellType !== undefined && cellType !== "code" && cellType !== "markdown")
        throw new ToolInputError('cell_type must be "code" or "markdown"');
      if (mode === "insert" && !cellType) throw new ToolInputError("cell_type is required to insert a cell");
      const id = str(o, "cell_id", true);
      if (mode !== "insert" && !id) throw new ToolInputError(`cell_id is required to ${mode} a cell`);
      const path = str(o, "notebook_path");
      if (!path.endsWith(".ipynb"))
        throw new ToolInputError("notebook_path must be a .ipynb file; use Edit for other files");
      return {
        path,
        source: mode === "delete" ? (str(o, "new_source", true) ?? "") : str(o, "new_source"),
        mode,
        ...(id ? { cellId: id } : {}),
        ...(cellType ? { cellType: cellType as "code" | "markdown" } : {}),
      };
    },
    access(a, ctx) {
      const p = resolvePath(a.path, ctx);
      const what = a.mode === "insert" ? `insert a ${a.cellType} cell` : `${a.mode} cell ${a.cellId}`;
      return { kind: "write", paths: [p], summary: `Edit ${display(p, ctx)} (${what})` };
    },
    async run(a, ctx) {
      const p = resolvePath(a.path, ctx);
      if (!existsSync(p)) return { content: `notebook not found: ${display(p, ctx)}`, isError: true };
      const stale = requireFreshRead(p, ctx);
      if (stale) return { content: stale, isError: true };
      let nb: Notebook;
      try {
        nb = loadNotebook(p);
      } catch (e) {
        return { content: `${display(p, ctx)}: ${(e as Error).message}`, isError: true };
      }
      let at = -1;
      if (a.cellId !== undefined) {
        at = findCell(nb, a.cellId);
        if (at < 0) {
          const ids = nb.cells.map(cellId).slice(0, 20).join(", ");
          return { content: `no cell "${a.cellId}" in ${display(p, ctx)}; cells: ${ids}`, isError: true };
        }
      }
      let done: string;
      if (a.mode === "delete") {
        nb.cells.splice(at, 1);
        done = `deleted cell ${a.cellId}`;
      } else if (a.mode === "insert") {
        const withIds = (nb.nbformat ?? 4) > 4 || ((nb.nbformat ?? 4) === 4 && (nb.nbformat_minor ?? 0) >= 5);
        const cell: Cell = {
          ...(withIds ? { id: randomBytes(4).toString("hex") } : {}),
          cell_type: a.cellType ?? "code",
          metadata: {},
          source: toSource(a.source),
          ...(a.cellType === "code" ? { outputs: [], execution_count: null } : {}),
        };
        nb.cells.splice(at + 1, 0, cell);
        done = `inserted ${cell.cell_type} cell ${cellId(cell, at + 1)} ${at < 0 ? "at the start" : `after ${a.cellId}`}`;
      } else {
        const cell = nb.cells[at] as Cell;
        cell.source = toSource(a.source);
        if (a.cellType && a.cellType !== cell.cell_type) {
          cell.cell_type = a.cellType;
          if (a.cellType === "markdown") {
            delete cell.outputs;
            delete cell.execution_count;
          }
        }
        if (cell.cell_type === "code") {
          cell.outputs = [];
          cell.execution_count = null;
        }
        done = `replaced cell ${a.cellId}`;
      }
      // Jupyter's own layout: one-space indent and a final newline.
      writeFileSync(p, `${JSON.stringify(nb, null, 1)}\n`);
      ctx.readState.set(p, mtime(p));
      return { content: `${done} in ${display(p, ctx)} (${nb.cells.length} cells)` };
    },
  };
}

export const isNotebook = (p: string) => p.endsWith(".ipynb") && existsSync(p) && statSync(p).isFile();
