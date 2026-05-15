/**
 * In-process CLI test runner. Creates a fresh Commander program per
 * invocation and captures all console / process.stdout output.
 */
import { buildProgram } from "~/program.ts";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunOptions {
  env?: Record<string, string>;
}

/**
 * Run a CLI command in-process, returning captured stdout/stderr and
 * an exit code. The process is never actually exited — `process.exit`
 * calls are intercepted and mapped to `exitCode`.
 */
export async function runCommand(
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  // Snapshot originals
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;
  const origExit = process.exit;
  const origEnv = { ...process.env };

  // Apply env overrides
  Object.assign(process.env, opts.env);

  // Capture console output
  console.log = (...a: unknown[]) => {
    stdoutChunks.push(a.map(String).join(" ") + "\n");
  };
  console.error = (...a: unknown[]) => {
    stderrChunks.push(a.map(String).join(" ") + "\n");
  };
  console.warn = (...a: unknown[]) => {
    stderrChunks.push(a.map(String).join(" ") + "\n");
  };
  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  let exitCode = 0;

  // Intercept process.exit — Commander calls it on --help / --version
  class ExitInterrupt {
    constructor(public code: number) {}
  }
  process.exit = ((code?: number) => {
    throw new ExitInterrupt(code ?? 0);
  }) as never;

  try {
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["node", "photon", ...args]);
  } catch (err) {
    if (err instanceof ExitInterrupt) {
      exitCode = err.code;
    } else if (
      err &&
      typeof err === "object" &&
      "exitCode" in err &&
      typeof (err as { exitCode: unknown }).exitCode === "number"
    ) {
      // Commander's CommanderError from exitOverride()
      exitCode = (err as { exitCode: number }).exitCode;
    } else {
      stderrChunks.push(String(err) + "\n");
      exitCode = 1;
    }
  } finally {
    // Restore everything
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    process.exit = origExit;

    // Restore env (remove added keys, restore originals)
    for (const key of Object.keys(opts.env ?? {})) {
      if (key in origEnv) {
        process.env[key] = origEnv[key];
      } else {
        delete process.env[key];
      }
    }
  }

  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    exitCode,
  };
}
