// Images and PDFs for Read (ADR-0022). An image goes to the model as an image when it can see
// (Ollama reports a "vision" capability). A PDF is turned into text with pdftotext (poppler)
// when it is installed; there is no PDF parser in teh itself.
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { display, type ToolContext, ToolInputError, type ToolResult } from "./tool";

export const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_PAGES = 20;

export const isImage = (p: string) => extname(p).toLowerCase() in IMAGE_TYPES;
export const isPdf = (p: string) => extname(p).toLowerCase() === ".pdf";

export function readImage(p: string, ctx: ToolContext): ToolResult {
  const size = statSync(p).size;
  const name = display(p, ctx);
  if (!ctx.vision)
    return {
      content: `${name} is an image, and the current model cannot see images. Ask the user to describe it, or to switch to a model with vision (for example gemma4).`,
      isError: true,
    };
  if (size > MAX_IMAGE_BYTES)
    return { content: `${name} is ${Math.round(size / 1e6)} MB; images up to 5 MB can be read`, isError: true };
  const mediaType = IMAGE_TYPES[extname(p).toLowerCase()] as string;
  return {
    content: `Image ${name} (${mediaType}, ${Math.round(size / 1024)} KB), attached below.`,
    images: [{ mediaType, data: readFileSync(p).toString("base64") }],
  };
}

// "3" or "1-5" → first and last page, 1-based.
export function parsePages(spec: string | undefined): { first: number; last: number } | undefined {
  if (spec === undefined) return undefined;
  const m = spec.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  if (!m) throw new ToolInputError('pages must look like "3" or "1-5"');
  const first = Number(m[1]);
  const last = m[2] ? Number(m[2]) : first;
  if (first < 1 || last < first) throw new ToolInputError("pages must be a range from page 1 up");
  if (last - first + 1 > MAX_PDF_PAGES) throw new ToolInputError(`at most ${MAX_PDF_PAGES} pages per read`);
  return { first, last };
}

async function pageCount(p: string): Promise<number | undefined> {
  if (!Bun.which("pdfinfo")) return undefined;
  const r = Bun.spawnSync(["pdfinfo", p], { stdout: "pipe", stderr: "ignore" });
  const m = r.stdout.toString().match(/^Pages:\s+(\d+)/m);
  return m ? Number(m[1]) : undefined;
}

export async function readPdf(
  p: string,
  pages: { first: number; last: number } | undefined,
  ctx: ToolContext,
): Promise<ToolResult> {
  const name = display(p, ctx);
  if (!Bun.which("pdftotext"))
    return {
      content: `${name} is a PDF, and reading PDFs needs pdftotext, which is not installed. Ask the user to install poppler (macOS: brew install poppler; Debian/Ubuntu: apt install poppler-utils).`,
      isError: true,
    };
  const total = await pageCount(p);
  const first = pages?.first ?? 1;
  const last = Math.min(pages?.last ?? first + MAX_PDF_PAGES - 1, total ?? Number.MAX_SAFE_INTEGER);
  if (total !== undefined && first > total) return { content: `${name} has ${total} pages`, isError: true };
  const r = Bun.spawnSync(["pdftotext", "-layout", "-f", String(first), "-l", String(last), p, "-"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) return { content: `could not read ${name}: ${r.stderr.toString().trim()}`, isError: true };
  // pdftotext separates pages with form feeds.
  const text = r.stdout
    .toString()
    .split("\f")
    .map((page, i) => (page.trim() ? `--- page ${first + i} ---\n${page.trimEnd()}` : ""))
    .filter(Boolean)
    .join("\n\n");
  const more =
    total !== undefined && last < total
      ? `\n\n(${total} pages in all; read more with pages "${last + 1}-${Math.min(total, last + MAX_PDF_PAGES)}")`
      : "";
  return { content: (text || "(no text on these pages; it may be a scanned PDF)") + more };
}
