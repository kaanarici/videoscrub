import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./process";
import { version } from "../package.json";

const dir = await mkdtemp(join(tmpdir(), "videoscrub-server-"));
const client = new Client({ name: "videoscrub-test", version: "1" });
const log = join(dir, "calls.jsonl");
const source = "https://example.test/video";

beforeAll(async () => {
  await mkdir(join(dir, "bin"));
  await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=black:s=160x90:r=10:d=2", "-pix_fmt", "yuv420p", join(dir, "clip.mp4")]);
  const downloader = join(dir, "bin", "yt-dlp");
  await Bun.write(downloader, `#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";
const args = process.argv.slice(2);
const output = args[args.indexOf("-o") + 1];
await appendFile(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args.at(-1).endsWith("/slow") && !await Bun.file(${JSON.stringify(join(dir, "started"))}).exists()) {
  await Bun.write(${JSON.stringify(join(dir, "started"))}, "started");
  await new Promise(resolve => setTimeout(resolve, 30000));
}
if (args.includes("--skip-download")) {
  await Bun.write(output.replace("%(ext)s", "info.json"), JSON.stringify({ title: "Fixture", duration: args.at(-1).endsWith("/no-duration") ? null : 2, width: 160, height: 90, fps: 10, acodec: "none", formats: [{ acodec: "aac" }] }));
  if (!args.at(-1).endsWith("/no-duration")) await Bun.write(output.replace("%(ext)s", "en.json3"), JSON.stringify({ events: [{ tStartMs: 500, segs: [{ utf8: "hello from captions" }] }] }));
} else {
  await Bun.write(output.replace("%(ext)s", "mp4"), Bun.file(${JSON.stringify(join(dir, "clip.mp4"))}));
}
`);
  await chmod(downloader, 0o755);
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["run", join(import.meta.dir, "server.ts")],
    env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, XDG_CACHE_HOME: join(dir, "cache"), OPENAI_API_KEY: "" },
    stderr: "pipe",
  }));
});

afterAll(async () => {
  await client.close();
  await rm(dir, { recursive: true, force: true });
});

const calls = async () => (await Bun.file(log).text()).trim().split("\n").map((line) => JSON.parse(line) as string[]);

test("plugin manifests and the MCP server share the package version", async () => {
  for (const path of ["plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
    expect((await Bun.file(join(import.meta.dir, "..", path)).json()).version).toBe(version);
  }
  expect(client.getServerVersion()?.version).toBe(version);
});

test.each(["mcp.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"])("the server command in %s starts and exposes the video tools", async (manifest) => {
  const root = join(import.meta.dir, "..");
  const config = (await Bun.file(join(root, manifest)).json()).mcpServers.videoscrub;
  const session = new Client({ name: "package-check", version: "1" });
  try {
    await session.connect(new StdioClientTransport({
      command: config.command,
      args: config.args.map((arg: string) => arg.replace(/\$\{(?:CLAUDE_)?PLUGIN_ROOT\}/g, root)),
      env: { PATH: process.env.PATH ?? "", XDG_CACHE_HOME: join(dir, "cache"), OPENAI_API_KEY: "" },
      stderr: "pipe",
    }));
    expect((await session.listTools()).tools.map((t) => t.name)).toEqual(["video_info", "transcript", "frames", "motion"]);
    const result = await session.callTool({ name: "frames", arguments: { source: join(dir, "clip.mp4") } });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain("2 frames from 0:00.0 to 0:02.0");
  } finally {
    await session.close();
  }
});

test("MCP metadata and captions avoid media downloads; frames reuse acquired media", async () => {
  const tools = await client.listTools();
  expect(tools.tools.map((t) => t.name)).toEqual(["video_info", "transcript", "frames", "motion"]);
  const info = await client.callTool({ name: "video_info", arguments: { source } });
  expect(info.isError).not.toBe(true);
  expect(JSON.stringify(info.content)).toContain("captions");
  const transcript = await client.callTool({ name: "transcript", arguments: { source } });
  expect(JSON.stringify(transcript.content)).toContain("hello from captions");
  expect(await calls()).toHaveLength(1);
  expect((await calls())[0]).toContain("--skip-download");
  for (let i = 0; i < 2; i++) {
    const result = await client.callTool({ name: "frames", arguments: { source, start_s: 0, end_s: 1 } });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain('"type":"image"');
  }
  expect(await calls()).toHaveLength(2);
  expect((await calls())[1]).toContain("bv[height<=720]/b[height<=720]/b");
  const invalid = await client.callTool({ name: "frames", arguments: { source, start_s: 0, end_s: 1, crop: { x: 0.8, y: 0, width: 0.5, height: 1 } } });
  expect(invalid.isError).toBe(true);
  expect(await calls()).toHaveLength(2);
});

test("MCP cancellation stops acquisition, removes staging, and permits retry", async () => {
  const abort = new AbortController();
  const pending = client.callTool({ name: "video_info", arguments: { source: source + "/slow" } }, undefined, { signal: abort.signal });
  const rejected = pending.then(() => false, () => true);
  for (let i = 0; i < 100 && !await Bun.file(join(dir, "started")).exists(); i++) await Bun.sleep(20);
  expect(await Bun.file(join(dir, "started")).exists()).toBe(true);
  abort.abort();
  expect(await rejected).toBe(true);
  const stages = async () => (await readdir(join(dir, "cache", "videoscrub"), { recursive: true })).filter((f) => /info-/.test(f));
  for (let i = 0; i < 100 && (await stages()).length; i++) await Bun.sleep(20);
  expect(await stages()).toEqual([]);
  const retry = await client.callTool({ name: "video_info", arguments: { source: source + "/slow" } });
  expect(retry.isError).not.toBe(true);
  expect(JSON.stringify(retry.content)).toContain("Fixture");
});

test("missing remote duration falls back to probing without losing separate audio availability", async () => {
  const info = await client.callTool({ name: "video_info", arguments: { source: source + "/no-duration" } });
  expect(info.isError).not.toBe(true);
  expect(JSON.stringify(info.content)).toContain("OPENAI_API_KEY");
  expect(JSON.stringify(info.content)).not.toContain("no audio track");
  expect((await calls()).filter((args) => args.at(-1) === source + "/no-duration")).toHaveLength(2);
});

test("a source alone scans the whole clip; cropped inspection upgrades and reuses source quality", async () => {
  const url = source + "/overview";
  const overview = await client.callTool({ name: "frames", arguments: { source: url } });
  expect(overview.isError).not.toBe(true);
  expect(JSON.stringify(overview.content)).toContain("2 frames from 0:00.0 to 0:02.0");
  const detail = await client.callTool({ name: "frames", arguments: { source: url, start_s: 0, end_s: 1, crop: { x: 0, y: 0, width: 0.5, height: 1 } } });
  expect(detail.isError).not.toBe(true);
  const acquired = (await calls()).filter((args) => args.at(-1) === url);
  expect(acquired).toHaveLength(3);
  expect(acquired[2]).toContain("bv/b");
  await client.callTool({ name: "frames", arguments: { source: url } });
  expect((await calls()).filter((args) => args.at(-1) === url)).toHaveLength(3);
});

test("high-frame-rate footage can be inspected at its native rate", async () => {
  const file = join(dir, "slow-motion.mp4");
  await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=120:d=1", "-pix_fmt", "yuv420p", file]);
  const result = await client.callTool({ name: "frames", arguments: { source: file, start_s: 0, end_s: 0.1, fps: 120 } });
  expect(result.isError).not.toBe(true);
  expect(JSON.stringify(result.content)).toContain("12 frames");
  expect(JSON.stringify(result.content)).toContain("120 fps");
});

test("the default embedded text track answers speech queries without a provider key", async () => {
  const subtitles = join(dir, "captions.srt");
  const alternate = join(dir, "alternate.srt");
  const file = join(dir, "captioned.mkv");
  await Bun.write(alternate, "1\n00:00:00,250 --> 00:00:00,800\nAlternate track.\n\n");
  await Bun.write(subtitles, "1\n00:00:00,250 --> 00:00:00,800\nThe launch is Friday.\n\n2\n00:00:01,100 --> 00:00:01,800\nBring <i>two</i> cameras.\n\n");
  await run("ffmpeg", ["-v", "error", "-i", join(dir, "clip.mp4"), "-i", alternate, "-i", subtitles, "-map", "0:v", "-map", "1:s", "-map", "2:s", "-c", "copy", "-disposition:s:0", "0", "-disposition:s:1", "default", file]);
  const info = await client.callTool({ name: "video_info", arguments: { source: file } });
  expect(info.isError).not.toBe(true);
  expect(JSON.stringify(info.content)).toContain("captions");
  const result = await client.callTool({ name: "transcript", arguments: { source: file, query: "launch" } });
  expect(result.isError).not.toBe(true);
  expect(result.content).toEqual([{ type: "text", text: "[0:00.3] The launch is Friday.\n[0:01.1] Bring two cameras." }]);
});
