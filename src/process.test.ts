import { expect, test } from "bun:test";
import { run } from "./process";

test("missing dependencies return an actionable error", async () => {
  await expect(run("videoscrub-missing-executable", [])).rejects.toThrow("videoscrub-missing-executable is not installed or is not on PATH.");
});

test("process failures retain a bounded diagnostic without echoing command arguments", async () => {
  const result = await run(process.execPath, ["-e", 'process.stderr.write("x".repeat(5000) + "decoder failed"); process.exit(1)', "private-argument"]).catch((error: Error) => error);
  expect(result).toBeInstanceOf(Error);
  const message = (result as Error).message;
  expect(message).toEndWith("decoder failed");
  expect(message.length).toBeLessThan(1600);
  expect(message).not.toContain("private-argument");
});

test("aborted commands preserve cancellation", async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(run(process.execPath, ["-e", "process.exit(0)"], abort.signal)).rejects.toThrow();
});

test("an empty diagnostic does not expose the command line", async () => {
  await expect(run(process.execPath, ["-e", "process.exit(2)", "private-argument"])).rejects.toThrow(`${process.execPath} failed (2).`);
});
