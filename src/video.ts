import { $ } from "bun";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const cache = () => join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "videoscrub");
const FORMAT = "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720]/b";

export type Line = { t: number; text: string };
export type Video = {
  dir: string;
  file: string;
  title: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  audio: boolean;
  chapters: { start_s: number; title: string }[];
  captions: Line[];
};

const opening = new Map<string, Promise<Video>>();

export function open(source: string): Promise<Video> {
  let pending = opening.get(source);
  if (!pending) {
    pending = load(source);
    opening.set(source, pending);
    pending.catch(() => opening.delete(source));
  }
  return pending;
}

async function load(source: string): Promise<Video> {
  const isFile = await stat(source).then((s) => s.isFile(), () => false);
  if (!isFile && !/^https?:\/\//.test(source)) throw new Error(`not a file or http(s) URL: ${source}`);
  const key = isFile ? await realpath(source) : source;
  const dir = join(cache(), createHash("sha1").update(key).digest("hex").slice(0, 16));
  await mkdir(dir, { recursive: true });
  const video = { dir, file: key, title: basename(key), chapters: [] as Video["chapters"], captions: [] as Line[] };
  if (!isFile) {
    if (!(await mediaFile(dir))) await download(source, dir);
    video.file = join(dir, (await mediaFile(dir))!);
    const info = JSON.parse(await readFile(join(dir, "video.info.json"), "utf8"));
    video.title = info.title ?? source;
    video.chapters = (info.chapters ?? []).map((c: { start_time: number; title: string }) => ({ start_s: c.start_time, title: c.title }));
    video.captions = await captions(dir);
  }
  return { ...video, ...(await probe(video.file)) };
}

async function mediaFile(dir: string) {
  return (await readdir(dir)).find((f) => /^video\.(mp4|webm|mkv|mov)$/.test(f));
}

async function download(url: string, dir: string) {
  await $`yt-dlp -q --no-warnings -f ${FORMAT} --merge-output-format mp4 --write-info-json --write-subs --write-auto-subs --sub-langs ${"en.*"} --sub-format json3 -o ${join(dir, "video.%(ext)s")} ${url}`.quiet();
}

async function captions(dir: string): Promise<Line[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json3"));
  const file = files.find((f) => f === "video.en.json3") ?? files[0];
  if (!file) return [];
  const { events } = JSON.parse(await readFile(join(dir, file), "utf8"));
  return events.flatMap((e: { tStartMs: number; segs?: { utf8: string }[] }) => {
    const text = (e.segs ?? []).map((s) => s.utf8).join("").replace(/\s+/g, " ").trim();
    return text ? [{ t: e.tStartMs / 1000, text }] : [];
  });
}

async function probe(file: string) {
  const out = await $`ffprobe -v error -show_entries stream=codec_type,width,height,avg_frame_rate:format=duration -of json ${file}`.json();
  const streams: { codec_type: string; width: number; height: number; avg_frame_rate: string }[] = out.streams;
  const v = streams.find((s) => s.codec_type === "video");
  if (!v) throw new Error(`no video stream in ${file}`);
  const [num, den] = v.avg_frame_rate.split("/").map(Number);
  return {
    duration: Number(out.format.duration),
    width: v.width,
    height: v.height,
    fps: Math.round((num! / den!) * 100) / 100,
    audio: streams.some((s) => s.codec_type === "audio"),
  };
}

export function hms(s: number, decimals = 1): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(decimals).padStart(3 + decimals, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
