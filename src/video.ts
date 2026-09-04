import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { run } from "./process";

export const cache = () => join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "videoscrub");
const formats = { video: "bv[height<=720]/b[height<=720]/b", detail: "bv/b", audio: "ba/b" };
const downloader = ["--ignore-config", "--no-playlist", "--no-warnings", "-q"];

export type Line = { t: number; text: string };
export type Video = {
  dir: string;
  source: { file: string } | { url: string };
  title: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  audio: boolean;
  chapters: { start_s: number; title: string }[];
  captions: Line[];
  subtitle?: number;
};

export async function open(source: string, signal?: AbortSignal): Promise<Video> {
  signal?.throwIfAborted();
  const local = await stat(source).catch(() => undefined);
  if (!local?.isFile() && !/^https?:\/\//.test(source)) throw new Error(`not a file or http(s) URL: ${source}`);
  const file = local?.isFile() ? await realpath(source) : undefined;
  const key = file ? `${file}:${local!.size}:${local!.mtimeMs}:${local!.ctimeMs}` : source;
  const dir = join(cache(), "v2-" + createHash("sha256").update(key).digest("hex").slice(0, 24));
  await mkdir(dir, { recursive: true });
  if (file) {
    return { dir, source: { file }, title: basename(file), captions: [], ...(await probe(file, signal)) };
  }
  const infoDir = join(dir, "info");
  if (!(await Bun.file(join(infoDir, "video.info.json")).exists())) {
    await acquire(dir, "info", async (tmp) => {
      await run("yt-dlp", [...downloader, "--skip-download", "--write-info-json", "--write-subs", "--write-auto-subs", "--sub-langs", "en.*,.*-orig", "--sub-format", "json3", "-o", join(tmp, "video.%(ext)s"), "--", source], signal);
      remoteInfo.parse(JSON.parse(await readFile(join(tmp, "video.info.json"), "utf8")));
    });
  }
  const info = remoteInfo.parse(JSON.parse(await readFile(join(infoDir, "video.info.json"), "utf8")));
  const entry = { dir, source: { url: source } };
  const details = info.duration ? {
    duration: info.duration, width: info.width ?? 0, height: info.height ?? 0, fps: info.fps ?? 0,
    chapters: info.chapters.map((c) => ({ start_s: c.start_time, title: c.title })),
  } : await probe(await media(entry, "video", signal), signal);
  return {
    ...entry, ...details, title: info.title,
    audio: info.acodec !== "none" || info.formats.some((f) => f.acodec && f.acodec !== "none"),
    captions: await captions(infoDir),
  };
}

const remoteInfo = z.object({
  title: z.string(), duration: z.number().positive().nullish(),
  width: z.number().nullable().optional(), height: z.number().nullable().optional(), fps: z.number().nullable().optional(),
  acodec: z.string().nullable().optional(),
  formats: z.array(z.object({ acodec: z.string().nullable().optional() })).default([]),
  chapters: z.array(z.object({ start_time: z.number(), title: z.string() })).nullish().transform((v) => v ?? []),
});

export async function media(video: Pick<Video, "dir" | "source">, kind: keyof typeof formats, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if ("file" in video.source) return video.source.file;
  const url = video.source.url;
  const dir = join(video.dir, kind);
  const existing = kind === "video" ? await mediaFile(join(video.dir, "detail")) ?? await mediaFile(dir) : await mediaFile(dir);
  if (existing) return existing;
  await acquire(video.dir, kind, async (tmp) => {
    await run("yt-dlp", [...downloader, "-f", formats[kind], "-o", join(tmp, "media.%(ext)s"), "--", url], signal);
    if (!(await mediaFile(tmp))) throw new Error(`Downloader returned no ${kind} file.`);
  });
  const file = await mediaFile(dir);
  if (!file) throw new Error(`Cached ${kind} is incomplete.`);
  return file;
}

async function mediaFile(dir: string) {
  const files = await readdir(dir).catch(() => []);
  const file = files.find((f) => /^media\.[a-z0-9]+$/.test(f) && !f.endsWith(".part") && !f.endsWith(".ytdl"));
  return file ? join(dir, file) : undefined;
}

async function acquire(parent: string, name: string, write: (tmp: string) => Promise<void>) {
  const tmp = await mkdtemp(join(parent, `${name}-`));
  try {
    await write(tmp);
    await rename(tmp, join(parent, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
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

async function probe(file: string, signal?: AbortSignal) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "stream=index,codec_type,codec_name,width,height,avg_frame_rate:stream_disposition=default:format=duration:chapter=start_time:chapter_tags=title", "-of", "json", file], signal);
  const out = z.object({
    streams: z.array(z.object({ index: z.number(), codec_type: z.string(), codec_name: z.string().optional(), width: z.number().optional(), height: z.number().optional(), avg_frame_rate: z.string().optional(), disposition: z.object({ default: z.number().optional() }).optional() })),
    format: z.object({ duration: z.coerce.number().positive() }),
    chapters: z.array(z.object({ start_time: z.coerce.number(), tags: z.object({ title: z.string().default("") }).default({ title: "" }) })).default([]),
  }).parse(JSON.parse(stdout));
  const streams = out.streams;
  const v = streams.find((s) => s.codec_type === "video");
  if (!v) throw new Error(`no video stream in ${file}`);
  const [num = 0, den = 0] = (v.avg_frame_rate ?? "0/0").split("/").map(Number);
  const subtitles = streams.filter((s) => s.codec_type === "subtitle" && ["subrip", "ass", "ssa", "mov_text", "webvtt", "text"].includes(s.codec_name ?? ""));
  return {
    duration: Number(out.format.duration),
    width: v.width ?? 0,
    height: v.height ?? 0,
    fps: den > 0 ? num / den : 0,
    audio: streams.some((s) => s.codec_type === "audio"),
    subtitle: (subtitles.find((s) => s.disposition?.default) ?? subtitles[0])?.index,
    chapters: out.chapters.map((c) => ({ start_s: c.start_time, title: c.tags.title })),
  };
}

export function hms(s: number, decimals = 1): string {
  s = Math.round(s * 10 ** decimals) / 10 ** decimals;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(decimals).padStart(3 + decimals, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
