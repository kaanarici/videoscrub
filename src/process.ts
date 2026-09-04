import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function run(command: string, args: string[], signal?: AbortSignal) {
  signal?.throwIfAborted();
  try {
    return await execute(command, args, { signal, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`${command} is not installed or is not on PATH.`);
    }
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    const detail = error instanceof Error && "stderr" in error && typeof error.stderr === "string" ? error.stderr.trim() : "";
    throw new Error(`${command} failed${code === undefined ? "" : ` (${code})`}${detail ? `: ${detail.slice(-1500)}` : "."}`);
  }
}
