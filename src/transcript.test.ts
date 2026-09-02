import { $ } from "bun";
import { afterAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format, lines, status } from "./transcript";
import { open, type Video } from "./video";

const spoken = Array.from({ length: 10 }, (_, i) => ({ t: i * 10, text: i === 5 ? "the needle is here" : `line ${i}` }));
const requests: { model: string | null; format: string | null; bytes: number; auth: string | null }[] = [];
const api = Bun.serve({
  port: 0,
  async fetch(req) {
    const form = await req.formData();
    const file = form.get("file") as File;
    requests.push({ model: form.get("model") as string, format: form.get("response_format") as string, bytes: file.size, auth: req.headers.get("authorization") });
    return Response.json({ segments: [{ start: 0.5, text: " hello " }, { start: 2, text: "" }, { start: 3.25, text: "world" }] });
  },
});
afterAll(() => api.stop());

test("format filters by range and by query with context", () => {
  expect(format(spoken, 0, 20)).toBe("[0:00.0] line 0\n[0:10.0] line 1\n[0:20.0] line 2");
  expect(format(spoken, undefined, undefined, "NEEDLE")).toBe(
    "[0:30.0] line 3\n[0:40.0] line 4\n[0:50.0] the needle is here\n[1:00.0] line 6\n[1:10.0] line 7",
  );
  expect(format(spoken, 0, 100, "missing")).toBe("No transcript lines match.");
});

test("captions win and a silent video has no transcript", async () => {
  const captioned = { captions: spoken, audio: true } as Video;
  expect(await status(captioned)).toBe("captions");
  expect(await lines(captioned)).toEqual({ status: "captions", lines: spoken });
  const silent = { captions: [], audio: false, dir: "/nonexistent" } as unknown as Video;
  expect(await status(silent)).toBe("none: no audio track");
  expect(await lines(silent)).toEqual({ status: "none: no audio track", lines: [] });
});

test("the API transcribes a video once, caches the lines, and needs a key", async () => {
  process.env.XDG_CACHE_HOME = await mkdtemp(join(tmpdir(), "videoscrub-cache-"));
  const file = join(await mkdtemp(join(tmpdir(), "videoscrub-")), "tone.mp4");
  await $`ffmpeg -v error -f lavfi -i sine=frequency=440:duration=6 -f lavfi -i color=black:s=160x90:r=10:d=6 -shortest -pix_fmt yuv420p ${file}`.quiet();
  const v = await open(file);
  delete process.env.OPENAI_API_KEY;
  expect(await status(v)).toStartWith("unavailable: set OPENAI_API_KEY");
  expect((await lines(v)).lines).toEqual([]);
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = `${api.url.origin}/v1/`;
  process.env.TRANSCRIBE_MODEL = "whisper-large-v3-turbo";
  expect(await status(v)).toStartWith("api");
  const expected = [{ t: 0.5, text: "hello" }, { t: 3.25, text: "world" }];
  expect(await Promise.all([lines(v), lines(v)])).toEqual([{ status: "ready", lines: expected }, { status: "ready", lines: expected }]);
  expect(requests).toEqual([{ model: "whisper-large-v3-turbo", format: "verbose_json", bytes: expect.any(Number), auth: "Bearer test-key" }]);
  expect(requests[0]!.bytes).toBeGreaterThan(10_000);
  expect(await status(v)).toBe("ready");
  expect(await lines(v)).toEqual({ status: "ready", lines: expected });
  expect(requests).toHaveLength(1);
  expect(await Bun.file(join(v.dir, "audio.mp3")).exists()).toBe(false);
});
