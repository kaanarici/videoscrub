# videoscrub

MCP server that lets a coding agent work through a video on demand: search the transcript, read a motion timeline, sample frames from a time range at a chosen frame rate, and zoom into a window at a higher rate. Works with any MCP host and any model with image input.

## Requirements

- Bun
- ffmpeg and ffprobe
- yt-dlp for URLs
- An OpenAI-compatible transcription API key for videos without captions (optional)

## Install

Claude Code plugin:

```bash
claude plugin marketplace add kaanarici/videoscrub
claude plugin install videoscrub@videoscrub
```

Claude Code or Codex from a clone:

```bash
claude mcp add videoscrub -- bun run /path/to/videoscrub/src/server.ts
codex mcp add videoscrub -- bun run /path/to/videoscrub/src/server.ts
```

Other hosts: command `bun`, args `run /path/to/videoscrub/src/server.ts`. The repo follows the Agent Plugins format (`plugin.json`, `mcp.json`). Bun installs the dependencies on first run.

Codex allows 60 seconds per tool call by default. The first call on a long video downloads it. Raise `mcp_servers.videoscrub.tool_timeout_sec` in `~/.codex/config.toml` if needed.

## Tools

| Tool | Input | Output |
| --- | --- | --- |
| `video_info` | `source` | title, duration, dimensions, fps, chapters, transcript status |
| `transcript` | `source`, optional `start_s`, `end_s`, `query` | timestamped lines; `query` returns matching lines with 2 lines of context |
| `motion` | `source`, `start_s`, `end_s` | up to 240 numbers, one per time bucket: the largest frame-to-frame luma change in that bucket |
| `frames` | `source`, `start_s`, `end_s`, `fps` (default 1), `width` (default 320) | contact sheets of sampled frames, each frame labeled with its timestamp |

`source` is a local path or an http(s) URL. Remote videos are downloaded once at up to 720p, with captions, into `~/.cache/videoscrub/`.

## Details

Transcript: captions when the video has them. Otherwise the first call encodes the audio to 24 kbps mono mp3, posts it to `OPENAI_BASE_URL` (default `https://api.openai.com/v1`) at `/audio/transcriptions` with `TRANSCRIBE_MODEL` (default `whisper-1`), and caches the segments. Groq: `OPENAI_BASE_URL=https://api.groq.com/openai/v1`, `TRANSCRIBE_MODEL=whisper-large-v3-turbo`. OpenRouter: its base URL. Audio over 25 MB, about two hours, is rejected. Without `OPENAI_API_KEY`, `video_info` reports the transcript as unavailable.

Motion: every source frame in the range is compared with the previous one at 64 px wide. Values are 0 to 255. Repeated actions appear as periodic bumps, cuts and flashes as isolated spikes, camera movement as a raised floor. Limit 600 seconds per call. About 600 tokens.

Frames: one ffmpeg command samples, scales, and tiles. Limit 48 frames per call; fps is capped at the video's rate. Width 320 gives 16 frames per 1280 px sheet, about 1,200 input tokens. Width 640 gives 4 per sheet, width 1280 one. The text part lists each tile's timestamp as well.

No audio tool. Speech reaches the model as text.

## Development

```bash
bun run check
```
