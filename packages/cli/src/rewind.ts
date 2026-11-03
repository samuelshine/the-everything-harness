// `teh rewind`: go back to any titled point of a session, restoring code, conversation or
// both (ADR-0004), with the same three choices as Claude Code's /rewind (ADR-0010).
// Nothing is lost: points you rewind past stay listed, and every rewind adds a point to return to.
import {
  CheckpointError,
  CheckpointStore,
  conversationAt,
  findProjectRoot,
  findSession,
  type LoadedSession,
  listSessions,
  type RestorePlan,
  type RewindPoint,
  type RewindScope,
  SessionLog,
  tehHome,
} from "@everything-harness/core";
import type { Io } from "./cli";

export type RewindArgs = {
  point?: string;
  scope?: RewindScope;
  session?: string;
  yes: boolean;
};

const SCOPES: { scope: RewindScope; label: string }[] = [
  { scope: "both", label: "Code and conversation" },
  { scope: "conversation", label: "Conversation only (files stay as they are)" },
  { scope: "code", label: "Code only (the conversation stays as it is)" },
];

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

export function pointLabel(p: RewindPoint): string {
  const title =
    p.kind === "prompt" ? `Start of prompt ${p.prompt}` : p.kind === "rewind" ? p.title : `Before: ${p.title}`;
  return p.rewound ? `${title}  (rewound)` : title;
}

export function renderPoints(s: LoadedSession): string {
  const lines = [`Rewind points · session ${s.id.slice(0, 18)}${s.model ? ` · ${s.model}` : ""}`, ""];
  let prompt = -1;
  let date = "";
  for (const p of s.points) {
    if (day(p.time) !== date) {
      date = day(p.time);
      lines.push(`${date}`);
    }
    if (p.prompt !== prompt) {
      prompt = p.prompt;
      lines.push(`  Prompt ${p.prompt}: "${clip(p.promptText, 64)}"`);
    }
    lines.push(`    ${String(p.n).padStart(3)}  ${clock(p.time)}  ${pointLabel(p)}`);
  }
  lines.push(`    now  ${clock(new Date())}  Current state`, "");
  return lines.join("\n");
}

function loadTarget(io: Io, root: string, ref?: string): LoadedSession | string {
  const home = tehHome(io.env);
  if (ref) return findSession(home, root, ref) ?? `no single session matches ${ref}; \`teh sessions\` lists them`;
  const latest = listSessions(home, root)[0];
  if (!latest) return "no sessions in this project yet";
  return findSession(home, root, latest.id) ?? "could not read the latest session";
}

export async function rewind(io: Io, args: RewindArgs): Promise<number> {
  const fail = (m: string, code = 2) => {
    io.err(`teh: ${m}\n`);
    return code;
  };
  const root = findProjectRoot(io.cwd);
  const home = tehHome(io.env);
  const session = loadTarget(io, root, args.session);
  if (typeof session === "string") return fail(session);
  if (session.points.length === 0) {
    io.out("This session has no points to rewind to yet.\n");
    return 0;
  }

  // 1. Pick a point.
  let ref = args.point;
  if (!ref) {
    io.out(renderPoints(session));
    if (!io.ask) {
      io.out("Rewind with: teh rewind <point> [--code-only | --conversation-only] [--yes]\n");
      return 0;
    }
    ref = (await io.ask("Rewind to which point? Enter a number, or press Enter to cancel:"))?.trim();
    if (!ref) {
      io.out("Nothing changed.\n");
      return 0;
    }
  }
  const point = session.points.find((p) => String(p.n) === ref);
  if (!point) return fail(`no point ${ref}; points run from 1 to ${session.points.length}`);

  // 2. Choose what goes back.
  let scope = args.scope;
  if (!scope && io.ask && !args.yes) {
    io.out(`\nRewind to point ${point.n}: ${pointLabel(point)}\nWhat should go back?\n`);
    for (const [i, s] of SCOPES.entries()) io.out(`  ${i + 1}  ${s.label}${i === 0 ? "  (default)" : ""}\n`);
    const answer = (await io.ask("Choose 1-3, Enter for the default, or n to cancel:"))?.trim().toLowerCase() ?? "";
    if (answer === "n" || answer === "q") {
      io.out("Nothing changed.\n");
      return 0;
    }
    scope = answer === "" ? "both" : SCOPES[Number(answer) - 1]?.scope;
    if (!scope) return fail(`"${answer}" is not one of 1, 2 or 3`);
  }
  scope ??= "both";

  // 3. Work out and show exactly what will change.
  const store = new CheckpointStore(home, root);
  let plan: RestorePlan | undefined;
  let before: string | undefined;
  io.out(`\nRewinding to point ${point.n}: ${pointLabel(point)}\n`);
  try {
    if (scope !== "conversation") {
      const why = store.unavailable();
      if (why) return fail(why);
      const target = point.sha ? await store.find(point.sha) : undefined;
      if (point.sha && !target) return fail(`the checkpoint for point ${point.n} is missing from ${store.gitDir}`, 1);
      if (!target) io.out("Files: teh changed nothing after this point, so there is nothing to restore.\n");
      else {
        const current = await store.snapshot("restore", session.id, `Before rewinding to point ${point.n}`);
        before = current.sha;
        const p = await store.plan(current, target);
        if (p.write.length || p.remove.length) {
          plan = p;
          io.out("Files:\n");
          for (const f of p.write) io.out(`  restore  ${f}\n`);
          for (const f of p.remove) io.out(`  delete   ${f}\n`);
        } else io.out("Files: already as they were at this point.\n");
        for (const f of p.skipped) io.out(`  keep     ${f}  (not covered by snapshots)\n`);
      }
    }

    let dropped = 0;
    if (scope !== "code") {
      // Reasoning is hidden from the person, so it is not counted as a message.
      const visible = (items: { kind: string }[]) => items.filter((i) => i.kind !== "reasoning").length;
      dropped = Math.max(0, visible(session.items) - visible(conversationAt(session.path, point)));
      io.out(
        dropped
          ? `Conversation: goes back to this point; ${dropped} later message${dropped === 1 ? "" : "s"} set aside.\n`
          : "Conversation: already at this point.\n",
      );
    }
    if (!plan && dropped === 0) {
      io.out("Nothing to do: you are already at this point.\n");
      return 0;
    }

    // 4. Confirm (ADR-0008: ask first).
    if (!args.yes) {
      if (!io.confirm) return fail("no terminal to confirm on; re-run with --yes");
      if (!(await io.confirm("Rewind?"))) {
        io.out("Nothing changed.\n");
        return 1;
      }
    }

    // 5. Apply, then record it so the rewind itself can be rewound.
    if (plan) await store.apply(plan);
    const log = new SessionLog(home, root, undefined, session);
    log.append("checkpoint", {
      kind: "rewind",
      title: `Before rewinding to point ${point.n}`,
      conversationAt: log.lastEventId,
      ...(before && plan ? { sha: before } : {}),
    });
    log.append("rewind", { to: point.conversationAt, scope, point: point.n });

    const back = session.points.length + 1;
    io.out(`\nDone. Changed your mind? Run \`teh rewind ${back}\` to return to how things were.\n`);
    if (scope !== "code") {
      if (point.kind === "prompt") {
        io.out(`Your prompt ${point.prompt} was:\n  ${point.promptText.replace(/\n/g, "\n  ")}\n`);
      }
      io.out('Continue from here with: teh -p -c "<your next prompt>"\n');
    }
    return 0;
  } catch (e) {
    if (e instanceof CheckpointError) return fail(e.message, 1);
    throw e;
  }
}
