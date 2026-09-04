import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { run } from "./process";
import { hms, media, type Line, type Video } from "./video";

const MAX_BYTES = 25 * 1024 * 1024;
export const MAX_TRANSCRIPT_CHARS = 12_000;
export type TranscriptPage = { text: string; nextOffset?: number };

const config = () => ({
  key: process.env.OPENAI_API_KEY,
  url: (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "") + "/audio/transcriptions",
  model: process.env.TRANSCRIBE_MODEL ?? "whisper-1",
});

const transcriptFile = (video: Video) => {
  const { url, model } = config();
  const key = createHash("sha256").update(JSON.stringify([url, model])).digest("hex").slice(0, 16);
  return join(video.dir, `transcript-${key}.json`);
};
const segments = z.array(z.object({ t: z.number().nonnegative(), text: z.string() }));

export async function status(video: Video): Promise<string> {
  if (video.captions.length || video.subtitle !== undefined) return "captions";
  if (await Bun.file(transcriptFile(video)).exists()) return "ready";
  if (!video.audio) return "none: no audio track";
  if (!config().key) return "unavailable: set OPENAI_API_KEY for transcription";
  return "api: transcribes on the first transcript call";
}

export async function lines(video: Video, signal?: AbortSignal): Promise<{ status: string; lines: Line[] }> {
  signal?.throwIfAborted();
  const state = await status(video);
  if (video.captions.length) return { status: state, lines: video.captions };
  if (video.subtitle !== undefined) {
    const file = await media(video, "video", signal);
    const { stdout } = await run("ffmpeg", ["-v", "error", "-i", file, "-map", `0:${video.subtitle}`, "-f", "srt", "pipe:1"], signal);
    const captions = [...stdout.matchAll(/^(\d+):(\d{2}):(\d{2}),(\d{3}) --> [^\r\n]+\r?\n([\s\S]*?)(?=\r?\n\r?\n|$)/gm)].map((m) => ({
      t: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000,
      text: m[5]!.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
    })).filter((line) => line.text);
    return { status: "captions", lines: captions };
  }
  if (state === "ready") return { status: state, lines: segments.parse(JSON.parse(await readFile(transcriptFile(video), "utf8"))) };
  if (!state.startsWith("api")) return { status: state, lines: [] };
  return { status: "ready", lines: await transcribe(video, signal) };
}

async function transcribe(video: Video, signal?: AbortSignal): Promise<Line[]> {
  const { key, url, model } = config();
  const dir = await mkdtemp(join(video.dir, "transcribe-"));
  try {
    const mp3 = join(dir, "audio.mp3");
    const file = await media(video, "audio", signal);
    await run("ffmpeg", ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "24k", mp3], signal);
    const audio = Bun.file(mp3);
    if (audio.size > MAX_BYTES) throw new Error("Audio exceeds the 25 MB transcription limit.");
    const body = new FormData();
    body.set("model", model);
    body.set("response_format", "verbose_json");
    body.set("file", audio, "audio.mp3");
    const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body, signal });
    if (!res.ok) throw new Error(`transcription failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const data = z.object({ segments: z.array(z.object({ start: z.number().nonnegative(), text: z.string() })) }).parse(await res.json());
    const result = data.segments.map((s) => ({ t: s.start, text: s.text.trim() })).filter((l) => l.text);
    const saved = join(dir, "transcript.json");
    await Bun.write(saved, JSON.stringify(result));
    signal?.throwIfAborted();
    await rename(saved, transcriptFile(video));
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function format(lines: Line[], start = 0, end = Infinity, query?: string, offset = 0): TranscriptPage {
  let kept = lines.filter((l) => l.t >= start && l.t <= end);
  if (query) {
    const q = query.toLowerCase();
    const keep = new Set<number>();
    kept.forEach((l, i) => {
      if (l.text.toLowerCase().includes(q)) for (let j = i - 2; j <= i + 2; j++) keep.add(j);
    });
    kept = kept.filter((_, i) => keep.has(i));
  }
  if (!kept.length) return { text: "No transcript lines match." };
  const full = kept.map((l) => `[${hms(l.t)}] ${l.text}`).join("\n");
  let next = Math.min(full.length, offset + MAX_TRANSCRIPT_CHARS);
  if (next < full.length) {
    const newline = full.lastIndexOf("\n", next - 1);
    if (newline >= offset) next = newline + 1;
    else if (/[\uD800-\uDBFF]/.test(full[next - 1]!)) next--;
  }
  return { text: full.slice(offset, next), nextOffset: next < full.length ? next : undefined };
}
