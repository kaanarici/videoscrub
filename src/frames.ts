import { Jimp, loadFont, measureText } from "jimp";
import { SANS_16_WHITE } from "jimp/fonts";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "./process";
import { cache, hms, media, type Video } from "./video";

export const MAX_FRAMES = 48;
export const MAX_SHEETS = 3;
export const MAX_MOTION_SECONDS = 600;
const SHEET_WIDTH = 1280;
const GAP = 4;
const LABEL_HEIGHT = 20;
const BUCKETS = 240;
let font: ReturnType<typeof loadFont> | undefined;

function clampRange(video: Video, start: number, end: number) {
  start = Math.max(0, start);
  end = Math.min(end, video.duration);
  if (end <= start) throw new Error(`empty range: video is ${hms(video.duration)} long`);
  return [start, end] as const;
}

export type Crop = { x: number; y: number; width: number; height: number };

export async function frames(video: Video, start: number, end: number, fps: number | undefined, width: number, crop?: Crop, signal?: AbortSignal) {
  [start, end] = clampRange(video, start, end);
  const seconds = end - start;
  const cols = Math.min(4, Math.max(1, Math.floor(SHEET_WIDTH / width)));
  const perSheet = cols * cols;
  const limit = Math.min(MAX_FRAMES, MAX_SHEETS * perSheet);
  fps ??= Math.min(1, limit / seconds);
  const count = Math.max(1, Math.ceil(seconds * fps - 1e-9));
  if (count > limit) {
    throw new Error(`${count} frames requested; at most ${limit} at width ${width}. Omit fps to fit this range, narrow the range, or reduce width.`);
  }
  const tmp = await mkdtemp(join(cache(), "tmp-"));
  try {
    const file = await media(video, crop || width > 640 ? "detail" : "video", signal);
    const region = crop ? `crop=iw*${crop.width}:ih*${crop.height}:iw*${crop.x}:ih*${crop.y},` : "";
    const filter = `select='isnan(prev_selected_t)+gt(floor(t*${fps}+0.000001),floor(prev_selected_t*${fps}+0.000001))',showinfo,${region}scale=${width}:${width}:force_original_aspect_ratio=decrease:force_divisible_by=2,tile=${cols}x${cols}:padding=${GAP}:margin=${GAP}:color=white`;
    const { stderr } = await run("ffmpeg", ["-hide_banner", "-loglevel", "info", "-ss", String(start), "-t", String(seconds), "-i", file, "-an", "-vf", filter, "-fps_mode", "passthrough", "-frames:v", String(Math.ceil(count / perSheet)), "-q:v", "4", join(tmp, "%03d.jpg")], signal);
    const files = (await readdir(tmp)).sort();
    const times = [...stderr.matchAll(/\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:([-\d.e+]+)/g)].map((m) => start + Number(m[1])).slice(0, MAX_FRAMES);
    if (!files.length || !times.length) throw new Error("No frames in this range. Widen the range.");
    const labels = times.map((t) => hms(t, 3));
    const sheets = await Promise.all(files.map((f, s) => label(join(tmp, f), labels.slice(s * perSheet, (s + 1) * perSheet), cols)));
    const shownFps = Number(fps.toPrecision(4));
    const frameWord = times.length === 1 ? "frame" : "frames";
    const sheetWord = sheets.length === 1 ? "sheet" : "sheets";
    const header = [
      `${times.length} ${frameWord} from ${hms(start)} to ${hms(end)}, sampled at up to ${shownFps} fps, fitting ${width}px, on ${sheets.length} ${sheetWord}${crop ? " (cropped)" : ""}.`,
      "Read tiles left to right, then top to bottom. Labels show source timestamps.",
    ].join("\n");
    return { header, sheets, times };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function label(file: string, texts: string[], cols: number) {
  font ??= loadFont(pathToFileURL(SANS_16_WHITE).href);
  const [sheet, fnt] = await Promise.all([Jimp.read(file), font]);
  const width = Math.round((sheet.width - 2 * GAP - (cols - 1) * GAP) / cols);
  const cellWidth = Math.max(width, ...texts.map((text) => measureText(fnt, text) + 4));
  const height = Math.round((sheet.height - 2 * GAP - (cols - 1) * GAP) / cols);
  const rows = Math.ceil(texts.length / cols);
  const usedCols = rows === 1 ? texts.length : cols;
  const output = new Jimp({
    width: 2 * GAP + usedCols * cellWidth + (usedCols - 1) * GAP,
    height: 2 * GAP + rows * (height + LABEL_HEIGHT) + (rows - 1) * GAP,
    color: 0xffffffff,
  });
  const strip = new Jimp({ width: cellWidth, height: LABEL_HEIGHT, color: 0x18212bff });
  texts.forEach((text, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const sourceX = GAP + col * (width + GAP);
    const sourceY = GAP + row * (height + GAP);
    const x = GAP + col * (cellWidth + GAP);
    const y = GAP + row * (height + LABEL_HEIGHT + GAP);
    output.blit({ src: strip, x, y });
    output.print({ font: fnt, x: x + 2, y, text });
    output.blit({ src: sheet, x: x + Math.floor((cellWidth - width) / 2), y: y + LABEL_HEIGHT, srcX: sourceX, srcY: sourceY, srcW: width, srcH: height });
  });
  return output.getBuffer("image/jpeg", { quality: 85 });
}

export async function motion(video: Video, start: number, end: number, signal?: AbortSignal) {
  [start, end] = clampRange(video, start, end);
  if (end - start > MAX_MOTION_SECONDS) throw new Error(`range is ${Math.round(end - start)} s; at most ${MAX_MOTION_SECONDS} s per call. Split it.`);
  const filter = "scale=64:-1,signalstats,metadata=print:key=lavfi.signalstats.YDIF:file=-";
  const file = await media(video, "video", signal);
  const { stdout: out } = await run("ffmpeg", ["-v", "error", "-ss", String(start), "-t", String(end - start), "-i", file, "-an", "-vf", filter, "-f", "null", "-"], signal);
  const samples = [...out.matchAll(/pts_time:([\d.]+)\s+lavfi\.signalstats\.YDIF=([\d.]+)/g)].map((m) => [start + Number(m[1]), Number(m[2])]);
  const buckets = Math.min(BUCKETS, samples.length);
  if (!buckets) throw new Error("No motion samples in this range. Widen the range.");
  const size = (end - start) / buckets;
  const values = new Array<number>(buckets).fill(0);
  for (const [t, v] of samples) {
    const i = Math.min(buckets - 1, Math.floor((t! - start) / size + 1e-9));
    values[i] = Math.max(values[i]!, v!);
  }
  const rows = [];
  for (let i = 0; i < buckets; i += 12) rows.push(`${hms(start + i * size).padStart(9)}  ${values.slice(i, i + 12).map((v) => Number(v.toPrecision(2))).join(" ")}`);
  const text = [
    `Motion from ${hms(start)} to ${hms(end)}: ${samples.length} frames at ${video.fps} fps in ${buckets} buckets of ${size.toFixed(3)} s. Each value is the largest frame-to-frame luma change (0-255) in that bucket; each row starts at the time shown.`,
    `Peaks locate visual change, not event counts. Confirm candidate times with frames.`,
    ...rows,
  ].join("\n");
  return { text, values, size };
}
