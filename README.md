# videoscrub

Agentic video understanding for any agent that speaks MCP. Instead of feeding a whole video into a model at a fixed frame rate, the model gets four tools and decides what to watch: it searches the transcript, reads a motion timeline to find where things happen, scans a range at low fps, then re-samples a narrow window at high fps and higher resolution to pin a moment, count an action, or read a detail. This is the same loop Google ships as `processing: "agentic"` for Gemini, but it runs on whatever model your host uses (Claude Code, Codex, Gemini CLI, Cursor).

## Requirements

- [Bun](https://bun.sh)
- `ffmpeg` and `ffprobe`
- `yt-dlp` for URLs
- An OpenAI-compatible transcription API key for videos without captions (optional)

## Install

Claude Code, as a plugin:

```bash
claude plugin marketplace add kaanarici/videoscrub
claude plugin install videoscrub@videoscrub
```

Claude Code or Codex, as a plain MCP server from a clone:

```bash
claude mcp add videoscrub -- bun run /path/to/videoscrub/src/server.ts
codex mcp add videoscrub -- bun run /path/to/videoscrub/src/server.ts
```

The repo is also an [Agent Plugins](https://agent-plugins.org) package, so clients that support that format install it from the git URL. Any other MCP host: command `bun`, args `run /path/to/videoscrub/src/server.ts`. Bun fetches the two dependencies on first run, so there is no install step.

Codex gives each tool call 60 seconds by default. The first call on a long video downloads it, so raise `mcp_servers.video.tool_timeout_sec` in `~/.codex/config.toml` if that is too tight.

## Tools

| Tool | Input | Returns |
| --- | --- | --- |
| `video_info` | `source` | title, duration, dimensions, fps, chapters, transcript status |
| `transcript` | `source`, optional `start_s`, `end_s`, `query` | timestamped lines; `query` returns matching lines with 2 lines of context |
| `motion` | `source`, `start_s`, `end_s` | up to 240 numbers, one per time bucket, giving the largest frame-to-frame change in that bucket |
| `frames` | `source`, `start_s`, `end_s`, `fps` (default 1), `width` (default 320) | contact sheets of sampled frames plus a text line giving each tile's timestamp |

`source` is a local path or an http(s) URL. Remote videos are downloaded once at up to 720p into `~/.cache/videoscrub/` together with their captions.

`transcript` uses captions when the video has them. Otherwise the first call encodes the audio to 24 kbps mono mp3, posts it to an OpenAI-compatible transcription endpoint, and caches the timestamped segments. Set `OPENAI_API_KEY` in the server's environment. The default is OpenAI's `whisper-1`, the OpenAI model that returns segment timestamps. For Groq set `OPENAI_BASE_URL=https://api.groq.com/openai/v1` and `TRANSCRIBE_MODEL=whisper-large-v3-turbo`; OpenRouter works the same way with its base URL. Files are capped at 25 MB, about two hours of audio. Without a key, `video_info` reports the transcript as unavailable and names the variable.

`motion` reads every source frame of the range at low resolution, so a one-frame flash still registers. Repeated actions show as periodic bumps, cuts and flashes as isolated spikes, camera movement as a raised floor. It covers at most 600 seconds per call and costs about 600 tokens.

`frames` runs one ffmpeg command to sample, scale, and tile. It accepts at most 48 frames per call and fps up to the video's own rate. At width 320 a sheet holds 16 frames in a 1280 px grid, about 1,200 input tokens, so roughly 75 tokens per frame. Width 640 gives 4 frames per sheet, width 1280 one full frame per sheet.

## Example

Asked when Ferris the crab first appears in "Rust in 100 Seconds", Claude Code called `video_info`, searched the transcript for "ferris" and "crab", scanned 0 to 96 s at 1 fps, re-sampled 27 to 28.1 s at 10 fps, then 27.4 to 27.55 s at 30 fps, and answered 0:27.5. Codex with GPT reached the same answer by a different route. The source, checked frame by frame, agrees.

## Limits

- No audio tool. Speech reaches the model as caption or transcription text, not sound.
- Timestamps sit in text next to the sheets rather than on the frames, because Homebrew's ffmpeg has no `drawtext`.
- Frame timing is computed from the sampling rate, so it is exact at the fps you asked for and no finer.

## Develop

```bash
bun run check
```
