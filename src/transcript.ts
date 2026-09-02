import { $ } from "bun";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { hms, type Line, type Video } from "./video";

const MAX_BYTES = 25 * 1024 * 1024;
const pending = new Map<string, Promise<Line[]>>();

const config = () => ({
  key: process.env.OPENAI_API_KEY,
  url: (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "") + "/audio/transcriptions",
  model: process.env.TRANSCRIBE_MODEL ?? "whisper-1",
});

export async function status(video: Video): Promise<string> {
  if (video.captions.length) return "captions";
  if (await Bun.file(join(video.dir, "transcript.json")).exists()) return "ready";
  if (!video.audio) return "none: no audio track";
  if (!config().key) return "unavailable: set OPENAI_API_KEY (and OPENAI_BASE_URL plus TRANSCRIBE_MODEL for Groq or OpenRouter)";
  return "api: transcribes on the first transcript call";
}

export async function lines(video: Video): Promise<{ status: string; lines: Line[] }> {
  const state = await status(video);
  if (state === "captions") return { status: state, lines: video.captions };
  if (state === "ready") return { status: state, lines: JSON.parse(await readFile(join(video.dir, "transcript.json"), "utf8")) };
  if (!state.startsWith("api")) return { status: state, lines: [] };
  let job = pending.get(video.dir);
  if (!job) {
    job = transcribe(video).finally(() => pending.delete(video.dir));
    pending.set(video.dir, job);
  }
  return { status: "ready", lines: await job };
}

async function transcribe(video: Video): Promise<Line[]> {
  const { key, url, model } = config();
  const mp3 = join(video.dir, "audio.mp3");
  await $`ffmpeg -v error -y -i ${video.file} -vn -ac 1 -ar 16000 -b:a 24k ${mp3}`.quiet();
  const audio = Bun.file(mp3);
  if (audio.size > MAX_BYTES) throw new Error(`audio is ${(audio.size / 1e6).toFixed(0)} MB; the API accepts 25 MB (about 2 hours)`);
  const body = new FormData();
  body.set("model", model);
  body.set("response_format", "verbose_json");
  body.set("file", audio, "audio.mp3");
  const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body });
  await rm(mp3, { force: true });
  if (!res.ok) throw new Error(`transcription failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const { segments } = (await res.json()) as { segments: { start: number; text: string }[] };
  const result = segments.map((s) => ({ t: s.start, text: s.text.trim() })).filter((l) => l.text);
  await Bun.write(join(video.dir, "transcript.json"), JSON.stringify(result));
  return result;
}

export function format(lines: Line[], start = 0, end = Infinity, query?: string): string {
  let kept = lines.filter((l) => l.t >= start && l.t <= end);
  if (query) {
    const q = query.toLowerCase();
    const keep = new Set<number>();
    kept.forEach((l, i) => {
      if (l.text.toLowerCase().includes(q)) for (let j = i - 2; j <= i + 2; j++) keep.add(j);
    });
    kept = kept.filter((_, i) => keep.has(i));
  }
  return kept.map((l) => `[${hms(l.t)}] ${l.text}`).join("\n") || "No transcript lines match.";
}
