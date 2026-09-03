import { $ } from "bun";
import { Jimp, loadFont } from "jimp";
import { SANS_16_WHITE } from "jimp/fonts";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cache, hms, type Video } from "./video";

export const MAX_FRAMES = 48;
export const MAX_MOTION_SECONDS = 600;
const SHEET_WIDTH = 1280;
const GAP = 4;
const BUCKETS = 240;
let font: ReturnType<typeof loadFont> | undefined;

function clampRange(video: Video, start: number, end: number) {
  start = Math.max(0, start);
  end = Math.min(end, video.duration);
  if (end <= start) throw new Error(`empty range: video is ${hms(video.duration)} long`);
  return [start, end] as const;
}

export async function frames(video: Video, start: number, end: number, fps: number, width: number) {
  [start, end] = clampRange(video, start, end);
  fps = Math.min(fps, video.fps);
  const count = Math.round((end - start) * fps) || 1;
  if (count > MAX_FRAMES) throw new Error(`${count} frames requested; at most ${MAX_FRAMES} per call. Narrow the range or lower fps.`);
  const cols = Math.min(4, Math.max(1, Math.floor(SHEET_WIDTH / width)));
  const perSheet = cols * cols;
  const tmp = await mkdtemp(join(cache(), "tmp-"));
  try {
    const filter = `fps=${fps},scale=${width}:-2,tile=${cols}x${cols}:padding=${GAP}:margin=${GAP}:color=white`;
    await $`ffmpeg -v error -ss ${start} -to ${end} -i ${video.file} -vf ${filter} -frames:v ${Math.ceil(count / perSheet)} -q:v 4 ${join(tmp, "%03d.jpg")}`.quiet();
    const files = (await readdir(tmp)).sort();
    const decimals = fps > 10 ? 2 : 1;
    const labels = Array.from({ length: count }, (_, i) => hms(start + i / fps, decimals));
    const sheets = await Promise.all(files.map((f, s) => label(join(tmp, f), labels.slice(s * perSheet, (s + 1) * perSheet), cols, width)));
    const header = [
      `${count} frames from ${hms(start)} to ${hms(end)} at ${fps} fps, ${width}px wide, on ${sheets.length} sheet(s) of ${cols}x${cols} tiles, each tile labeled with its time.`,
      `Tiles are numbered row by row, continuing across sheets; unused tiles are blank. Tile times: ${labels.map((t, i) => `#${i + 1} ${t}`).join(", ")}.`,
    ].join("\n");
    return { header, sheets };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function label(file: string, texts: string[], cols: number, width: number) {
  font ??= loadFont(pathToFileURL(SANS_16_WHITE).href);
  const [sheet, fnt] = await Promise.all([Jimp.read(file), font]);
  const height = (sheet.height - 2 * GAP - (cols - 1) * GAP) / cols;
  texts.forEach((text, i) => {
    const x = GAP + (i % cols) * (width + GAP);
    const y = GAP + Math.floor(i / cols) * (height + GAP);
    sheet.composite(new Jimp({ width: 9 * text.length + 8, height: 20, color: 0x000000e0 }), x, y);
    sheet.print({ font: fnt, x: x + 4, y: y + 1, text });
  });
  return sheet.getBuffer("image/jpeg", { quality: 85 });
}

export async function motion(video: Video, start: number, end: number) {
  [start, end] = clampRange(video, start, end);
  if (end - start > MAX_MOTION_SECONDS) throw new Error(`range is ${Math.round(end - start)} s; at most ${MAX_MOTION_SECONDS} s per call. Split it.`);
  const filter = "scale=64:-1,signalstats,metadata=print:key=lavfi.signalstats.YDIF:file=-";
  const out = await $`ffmpeg -v error -ss ${start} -to ${end} -i ${video.file} -vf ${filter} -f null -`.text();
  const samples = [...out.matchAll(/pts_time:([\d.]+)\s+lavfi\.signalstats\.YDIF=([\d.]+)/g)].map((m) => [start + Number(m[1]), Number(m[2])]);
  const buckets = Math.min(BUCKETS, samples.length);
  const size = (end - start) / buckets;
  const values = new Array<number>(buckets).fill(0);
  for (const [t, v] of samples) {
    const i = Math.min(buckets - 1, Math.floor((t! - start) / size));
    values[i] = Math.max(values[i]!, v!);
  }
  const rows = [];
  for (let i = 0; i < buckets; i += 12) rows.push(`${hms(start + i * size).padStart(9)}  ${values.slice(i, i + 12).map((v) => Math.round(v)).join(" ")}`);
  const text = [
    `Motion from ${hms(start)} to ${hms(end)}: ${samples.length} frames at ${video.fps} fps in ${buckets} buckets of ${size.toFixed(3)} s. Each value is the largest frame-to-frame luma change (0-255) in that bucket; each row starts at the time shown.`,
    `Periodic bumps are repeated actions, isolated spikes are cuts or flashes, a raised floor is camera movement.`,
    ...rows,
  ].join("\n");
  return { text, values, size };
}
