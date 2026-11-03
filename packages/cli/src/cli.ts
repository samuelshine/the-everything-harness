// Argument parsing and dispatch, kept free of process globals so it can be tested.
import { VERSION } from "@everything-harness/core";

export type Io = { out: (s: string) => void; err: (s: string) => void };

export const USAGE = `Usage: teh [options]

Options:
  -p, --print <prompt>  Run one prompt headlessly and print the result (not implemented yet)
  -v, --version         Print the version
  -h, --help            Show this help
`;

export async function run(argv: string[], io: Io): Promise<number> {
  const [arg, ...rest] = argv;
  switch (arg) {
    case "-v":
    case "--version":
      io.out(`teh ${VERSION}\n`);
      return 0;
    case undefined:
    case "-h":
    case "--help":
      io.out(USAGE);
      return 0;
    case "-p":
    case "--print":
      if (rest.length === 0) {
        io.err("teh: --print needs a prompt\n");
        return 2;
      }
      io.err("teh: headless mode is not implemented yet\n");
      return 1;
    default:
      io.err(`teh: unknown option '${arg}'\n\n${USAGE}`);
      return 2;
  }
}
