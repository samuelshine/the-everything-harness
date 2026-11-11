// Base system prompt. Model-family overlays (ADR-0002) will be layered on top.

export type PromptEnv = {
  cwd: string;
  projectRoot: string;
  platform: string;
  date: string;
  isGitRepo: boolean;
  instructions: string;
  // Name and description of each skill the model may load (ADR-0015).
  skills?: string;
  skillsOmitted?: number;
  // The session's output style (ADR-0015); none or "default" keeps the base prompt.
  style?: { name: string; body: string; keepCodingInstructions: boolean };
  // Usage notes that connected MCP servers sent when they started (ADR-0017).
  mcpInstructions?: { server: string; text: string }[];
};

const IDENTITY = `You are teh (The Everything Harness), a coding agent working in the user's terminal.
You help with software engineering tasks: reading and changing code, running commands, and explaining what you find.`;

// Coding guidance; an output style can drop it (keep-coding-instructions: false).
const CODING = `How to work:
- Investigate before acting. Use Glob and Grep to find code and Read to inspect it; do not guess file contents.
- Read a file before you Edit or overwrite it. Make the smallest change that solves the task and match the surrounding style.
- Prefer Edit for changes to existing files; use Write only for new files or full rewrites.
- Use Bash for builds, tests and other commands. Prefer the dedicated tools over cat, grep or find.`;

// Always kept, whatever the style.
const SAFETY = `- Some actions need the user's approval. If one is denied, do not retry it unchanged: adjust your approach or explain what you need.
- Do not invent results you did not observe.`;

// Response format; an output style replaces it.
const FORMAT = "- When you are done, reply with a short summary of what you did and anything the user should check.";

function basePrompt(style: PromptEnv["style"]): string {
  if (!style?.body) return `${IDENTITY}\n\n${CODING}\n${SAFETY}\n${FORMAT}`;
  const head = style.keepCodingInstructions
    ? `${IDENTITY}\n\n${CODING}\n${SAFETY}`
    : `${IDENTITY}\n\nAlways:\n${SAFETY}`;
  return `${head}\n\n<output_style name="${style.name}">
The user chose this output style for the session. Follow it for how you work and respond.
${style.body}
</output_style>`;
}

export function systemPrompt(env: PromptEnv): string {
  const parts = [
    basePrompt(env.style),
    `<environment>
working_directory: ${env.cwd}
project_root: ${env.projectRoot}
git_repository: ${env.isGitRepo ? "yes" : "no"}
platform: ${env.platform}
date: ${env.date}
</environment>`,
  ];
  if (env.skills) {
    parts.push(`<skills>
Skills are instructions for specific kinds of task. When the user's request matches a skill's description, call the Skill tool with that skill's name before starting, then follow what it returns. If a skill's instructions are already in the conversation, follow them without loading it again.
${env.skills}${env.skillsOmitted ? `\n(${env.skillsOmitted} more skills are not listed; the Skill tool can still load them by name.)` : ""}
</skills>`);
  }
  if (env.mcpInstructions?.length) {
    const notes = env.mcpInstructions.map(
      (m) => `<server name="${m.server}">\n${m.text.trim().slice(0, 4000)}\n</server>`,
    );
    parts.push(
      `<mcp_servers>\nThese servers provide the mcp__<server>__* tools. Their notes on using them:\n${notes.join("\n")}\n</mcp_servers>`,
    );
  }
  if (env.instructions) {
    parts.push(
      `The project provides these instructions. Follow them unless the user says otherwise.\n\n${env.instructions}`,
    );
  }
  return parts.join("\n\n");
}
