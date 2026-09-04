import { $ } from "bun";
import { Jimp } from "jimp";
import { beforeAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frames, MAX_MOTION_SECONDS, motion } from "./frames";
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
  const { header, sheets, times } = await frames(clip, 2, 6, 1, 320);
  expect(sheets).toHaveLength(1);
  expect(header).toContain("4 frames from 0:02.0 to 0:06.0");
  expect(times).toEqual([2, 3, 4, 5]);
  expect(sheets[0]!.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  const sheet = await Jimp.read(sheets[0]!);
  expect([sheet.width, sheet.height]).toEqual([1300, 208]);
  const dark = (x: number, y: number) => (sheet.getPixelColor(x, y) >>> 8) & 0xff;
  expect(dark(6, 26)).toBeLessThan(40);
  expect(dark(6 + 324, 26)).toBeLessThan(40);
  expect(dark(6 + 3 * 324, 26)).toBeLessThan(40);
  expect(dark(300, 6)).toBeLessThan(80);
});

test("frames spans sheets at full width, never duplicates source frames, and refuses oversize requests", async () => {
  expect((await frames(clip, 0, 3, 1, 1280)).sheets).toHaveLength(3);
  const fast = await frames(clip, 0, 0.5, 60, 320);
  expect(fast.times).toHaveLength(15);
  expect(fast.times[1]).toBeCloseTo(1 / 30, 5);
  await expect(frames(clip, 0, 20, 10, 320)).rejects.toThrow("Omit fps");
  await expect(frames(clip, 25, 30, 1, 320)).rejects.toThrow("empty range");
});

test("variable-rate video retains detail above its average frame rate", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "videoscrub-")), "variable.mp4");
  await $`ffmpeg -v error -f lavfi -i testsrc2=s=160x90:r=10:d=5 -vf ${"select='lt(t,1)+eq(mod(n,10),0)'"} -fps_mode vfr -pix_fmt yuv420p ${file}`.quiet();
  const video = await open(file);
  expect(video.fps).toBeLessThan(10);
  const result = await frames(video, 0, 0.5, 10, 320);
  expect(result.times).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
});

test("frames chooses a fitting rate and removes unused tile space", async () => {
  const adaptive = await frames(clip, 0, 20, undefined, 320);
  expect(adaptive.times).toHaveLength(20);
  const one = await frames(clip, 0, 1, undefined, 320);
  const sheet = await Jimp.read(one.sheets[0]!);
  expect([sheet.width, sheet.height]).toEqual([328, 208]);
});

test("high-resolution scans fit three sheets and reject oversized explicit rates", async () => {
  const result = await frames(clip, 0, 20, undefined, 1280);
  expect(result.sheets).toHaveLength(3);
  expect(result.times).toHaveLength(3);
  expect(result.times.at(-1)).toBeGreaterThan(13);
  await expect(frames(clip, 0, 4, 10, 1280)).rejects.toThrow("at most 3 at width 1280");
});

test("fractional ranges return only real frames with source timestamps", async () => {
  const result = await frames(clip, 2.05, 3.2, 1, 320);
  expect(result.times).toHaveLength(2);
  expect(result.times[0]).toBeCloseTo(2.066667, 5);
  expect(result.times[1]).toBeCloseTo(3.066667, 5);
  const crop = await frames(clip, 0, 1, 1, 320, { x: 0, y: 0, width: 0.5, height: 1 });
  const sheet = await Jimp.read(crop.sheets[0]!);
  expect([sheet.width, sheet.height]).toEqual([292, 348]);
});

test("portrait frames and tall crops fit the same pixel budget", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "videoscrub-")), "portrait.mp4");
  await $`ffmpeg -v error -f lavfi -i testsrc2=s=180x960:r=10:d=1 -pix_fmt yuv420p ${file}`.quiet();
  const result = await frames(await open(file), 0, 1, 1, 320);
  const portrait = await Jimp.read(result.sheets[0]!);
  expect(portrait.height).toBe(348);
  expect(portrait.width).toBeLessThanOrEqual(328);
  const narrow = await frames(clip, 0, 1, 1, 320, { x: 0, y: 0, width: 0.01, height: 1 });
  const sheet = await Jimp.read(narrow.sheets[0]!);
  expect(sheet.height).toBe(348);
  expect(sheet.width).toBeLessThanOrEqual(328);
});

test("automatic sampling covers a long range without rate arithmetic", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "videoscrub-")), "long.mp4");
  await $`ffmpeg -v error -f lavfi -i color=black:s=160x90:r=1:d=120 -pix_fmt yuv420p ${file}`.quiet();
  const result = await frames(await open(file), 0, 120, undefined, 320);
  expect(result.times).toHaveLength(48);
  expect(result.times[0]).toBe(0);
  expect(result.times.at(-1)).toBeGreaterThan(115);
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
  expect(text.split("\n")[2]).toStartWith("   0:00.0  ");
  expect(text.split("\n")[2]!.trim().split(/\s+/).slice(1).map(Number)).toEqual(values.slice(0, 12).map((v) => Number(v.toPrecision(2))));
});

test("motion preserves subtle changes and their bucket boundaries", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "videoscrub-")), "subtle.mp4");
  await $`ffmpeg -v error -f lavfi -i color=c=0x18212b:s=640x360:r=20:d=4 -vf ${"drawbox=x=260:y=140:w=120:h=80:c=blue:t=fill:enable='gte(t,3.8)'"} -pix_fmt yuv420p ${file}`.quiet();
  const { text, values, size } = await motion(await open(file), 0, 4);
  expect(size).toBe(0.05);
  expect(values[75]).toBe(0);
  expect(values[76]).toBeGreaterThan(0);
  expect(values[76]).toBeLessThan(0.5);
  const shown = text.split("\n").slice(2).flatMap((row) => row.trim().split(/\s+/).slice(1).map(Number));
  expect(shown[76]).toBeCloseTo(values[76]!, 3);
  expect(shown[76]).toBeGreaterThan(0);
});

test("motion refuses ranges longer than the cap", async () => {
  await expect(motion({ ...clip, duration: 10_000 }, 0, MAX_MOTION_SECONDS + 1)).rejects.toThrow("Split it");
});
