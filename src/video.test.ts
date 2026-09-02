import { $ } from "bun";
import { beforeAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hms, open } from "./video";

let file: string;
beforeAll(async () => {
  process.env.XDG_CACHE_HOME = await mkdtemp(join(tmpdir(), "video-tool-cache-"));
  file = join(await mkdtemp(join(tmpdir(), "video-tool-")), "clip.mp4");
  await $`ffmpeg -v error -f lavfi -i testsrc2=size=640x360:rate=10:duration=12 -pix_fmt yuv420p ${file}`.quiet();
});

test("open probes a local file", async () => {
  const v = await open(file);
  expect(v.duration).toBeCloseTo(12, 1);
  expect([v.width, v.height, v.fps, v.audio]).toEqual([640, 360, 10, false]);
  expect(v.title).toBe("clip.mp4");
  expect(v.captions).toEqual([]);
  expect(v.chapters).toEqual([]);
});

test("open rejects sources that are neither files nor URLs", async () => {
  await expect(open("/nope/missing.mp4")).rejects.toThrow("not a file or http(s) URL");
});

test("hms formats seconds", () => {
  expect(hms(0)).toBe("0:00.0");
  expect(hms(65.26)).toBe("1:05.3");
  expect(hms(3661)).toBe("1:01:01.0");
  expect(hms(27.4667, 2)).toBe("0:27.47");
});
