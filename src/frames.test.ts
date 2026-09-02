import { $ } from "bun";
import { beforeAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frames, MAX_FRAMES, MAX_MOTION_SECONDS, motion } from "./frames";
import { open, type Video } from "./video";

let clip: Video;
beforeAll(async () => {
  process.env.XDG_CACHE_HOME = await mkdtemp(join(tmpdir(), "videoscrub-cache-"));
  const file = join(await mkdtemp(join(tmpdir(), "videoscrub-")), "motion.mp4");
  const box = "overlay=x='if(between(t,5,10),mod(floor(t*2),4)*60,0)':y=50:eval=frame";
  const flash = "drawbox=c=white:t=fill:enable='eq(n,369)'";
  const cut = "drawbox=c=gray:t=fill:enable='gte(t,15)'";
  await $`ffmpeg -v error -f lavfi -i color=black:s=320x180:r=30:d=20 -f lavfi -i color=white:s=80x80:r=30:d=20 -filter_complex ${`[0][1]${box},${flash},${cut}`} -pix_fmt yuv420p ${file}`.quiet();
  clip = await open(file);
});

test("frames tiles a range and lists each tile's time", async () => {
  const { header, sheets } = await frames(clip, 2, 6, 1, 320);
  expect(sheets).toHaveLength(1);
  expect(header).toContain("4 frames from 0:02.0 to 0:06.0 at 1 fps, 320px wide, on 1 sheet(s) of 4x4 tiles");
  expect(header).toContain("#1 0:02.0, #2 0:03.0, #3 0:04.0, #4 0:05.0");
  expect(sheets[0]!.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
});

test("frames spans sheets at full width, caps fps at the source rate, and refuses oversize requests", async () => {
  expect((await frames(clip, 0, 3, 1, 1280)).sheets).toHaveLength(3);
  const fast = (await frames(clip, 0, 1, 60, 320)).header;
  expect(fast).toContain("30 frames from 0:00.0 to 0:01.0 at 30 fps");
  expect(fast).toContain("#1 0:00.00, #2 0:00.03, #3 0:00.07");
  await expect(frames(clip, 0, 20, 10, 320)).rejects.toThrow(`at most ${MAX_FRAMES}`);
  await expect(frames(clip, 25, 30, 1, 320)).rejects.toThrow("empty range");
});

test("motion shows a static scene, ten jumps, a one-frame flash, and a hard cut", async () => {
  const { text, values, size } = await motion(clip, 0, 20);
  const at = (t: number) => values[Math.floor(t / size)]!;
  const spikes = (from: number, to: number) => values.filter((v, i) => i * size >= from && i * size < to && v > 20).length;
  expect(values).toHaveLength(240);
  expect(Math.max(...values.slice(0, Math.floor(5 / size)))).toBeLessThan(2);
  expect(spikes(4.9, 10.1)).toBe(11);
  expect(Math.max(at(12.25), at(12.3), at(12.35))).toBeGreaterThan(100);
  expect(at(15)).toBeGreaterThan(20);
  expect(Math.max(...values.slice(Math.ceil(15.2 / size)))).toBeLessThan(2);
  expect(text).toContain("600 frames at 30 fps in 240 buckets of 0.083 s");
  expect(text.split("\n")[2]).toMatch(/^ {3}0:00\.0  0 0 0 0 0 0 0 0 0 0 0 0$/);
});

test("motion refuses ranges longer than the cap", async () => {
  await expect(motion({ ...clip, duration: 10_000 }, 0, MAX_MOTION_SECONDS + 1)).rejects.toThrow("Split it");
});
