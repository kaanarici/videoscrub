# videoscrub

Ask your coding agent questions about a video.

Give it a local file or a video link. videoscrub lets the agent inspect frames, find moments, and search captions. It works with Codex, Claude Code, and other MCP hosts that support image input.

> "When does the presenter open the settings panel?"
>
> "What changes between the beginning and end of this recording?"
>
> "How many times does the indicator turn on? Give me the timestamps."

Your agent chooses what to inspect. You do not need to pick frame rates or learn the tools.

## Install

Install [Bun](https://bun.sh), [ffmpeg](https://ffmpeg.org/download.html), and [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation). ffmpeg includes ffprobe. You only need yt-dlp for video links.

On macOS with Homebrew, install the video tools with:

```sh
brew install ffmpeg yt-dlp
```

### Codex

```sh
codex plugin marketplace add kaanarici/videoscrub
codex plugin add videoscrub@videoscrub
```

### Claude Code

```sh
claude plugin marketplace add kaanarici/videoscrub
claude plugin install videoscrub@videoscrub
```

Start a new session after installation. Then ask a question and include the video's path or URL. Bun installs the plugin's dependencies on first use.

### Other MCP hosts

Clone the repository and install its dependencies:

```sh
git clone https://github.com/kaanarici/videoscrub.git
cd videoscrub
bun install --frozen-lockfile
```

Add this server to your host's MCP configuration. Replace the path with the absolute path to your clone.

```json
{
	"mcpServers": {
		"videoscrub": {
			"command": "bun",
			"args": ["run", "/absolute/path/to/videoscrub/src/server.ts"]
		}
	}
}
```

This registers the tools. The [bundled skill](skills/analyze-video/SKILL.md) is also available for hosts that support skills.

## What to expect

No extra API key is needed to inspect frames or read available captions. Your existing agent interprets the images and text; videoscrub does not run another reasoning model.

Videos without captions need an optional [speech transcription service](docs/reference.md#speech-transcription) for spoken content. Music and other sounds are not supported.

Brief events can fall between sampled frames. Your agent can inspect a shorter interval at a higher frame rate, but accuracy still depends on the model and the evidence it requests.

Video links must be accessible to yt-dlp. Login requirements and site restrictions still apply. Long downloads may need a longer tool timeout in your host.

Frames and transcript text go to your agent's model. If you enable speech transcription, audio also goes to your configured transcription provider. Downloads and transcripts are cached locally.

## Update

For Codex:

```sh
codex plugin marketplace upgrade videoscrub
codex plugin add videoscrub@videoscrub
```

For Claude Code:

```sh
claude plugin marketplace update videoscrub
claude plugin update videoscrub@videoscrub
```

For a Git clone, run `git pull --ff-only` and `bun install --frozen-lockfile`. Restart your agent session after updating.

See [releases](https://github.com/kaanarici/videoscrub/releases) for changes and upgrade notes.

## Contribute

Run `bun install --frozen-lockfile`, then `bun run check`. The suite checks types and exercises the MCP server with generated videos and a mock transcription service. No API key is needed.

[Issues](https://github.com/kaanarici/videoscrub/issues) and pull requests are welcome. For a bug report, include your host, operating system, error, and a shareable clip or reproduction steps.

See the [tool reference](docs/reference.md) for parameters, limits, and cache behavior. MIT licensed.
