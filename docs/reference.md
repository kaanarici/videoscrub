# Tool reference

All four tools accept `source`, a local file path or an HTTP or HTTPS URL supported by yt-dlp. Times are in seconds.

## `video_info`

Returns the title, duration, dimensions, frame rate, chapters, and transcript availability.

Remote metadata and captions are fetched without downloading the video. If the source has no duration in its metadata, videoscrub downloads the video to measure it.

## `frames`

Returns JPEG sheets of timestamped frames. A request with only `source` scans the whole video.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `start_s` | `0` | Start of the range |
| `end_s` | Video duration | End of the range |
| `fps` | Automatic | Requested frames per second |
| `width` | `320` | Maximum width and height of each frame, from 160 to 1280 pixels |
| `crop` | Full frame | `{x, y, width, height}`, each in 0–1 coordinates from the top left |

The automatic rate is at most 1 FPS and decreases to fit the range. Explicit rates can exceed 60 FPS, but requests must fit within three sheets.

| `width` | Maximum frames per call |
| --- | --- |
| `320` | 48 |
| `640` | 12 |
| `1280` | 3 |

Frames preserve their aspect ratio. Labels sit outside the video image and show source timestamps. videoscrub never duplicates frames to fill a requested rate.

Sparse samples can miss brief events. For precise timing, inspect the frames immediately before and after a change in a narrow range.

## `transcript`

Returns timestamped speech text. Available captions take precedence over API transcription.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `start_s` | `0` | Earliest line start time |
| `end_s` | No limit | Latest line start time |
| `query` | No filter | Case-insensitive substring search, with two nearby lines on either side |
| `offset` | `0` | Continuation offset returned by a previous request |

Pages contain at most 12,000 characters, plus a continuation instruction. Keep the same source, range, and query when using the returned offset.

Remote captions use available English or original-language tracks. Local files use the default text subtitle track, or the first text track if none is marked as default. Bitmap subtitles are not supported.

### Speech transcription

For videos without captions, set these environment variables on the MCP server:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | Unset | Enables audio uploads to the transcription service |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible API endpoint |
| `TRANSCRIBE_MODEL` | `whisper-1` | Transcription model |

The first transcript request encodes audio as 24 kbps mono MP3 and sends it to `/audio/transcriptions`. Provider charges apply. Encoded audio over 25 MB is rejected.

Alternate providers must accept `verbose_json` and return timestamped `segments`. Results are cached by source, endpoint, and model. Transcripts describe speech, not music or other sounds.

## `motion`

Requires `start_s` and `end_s`. Returns up to 240 time buckets across a range of at most 600 seconds.

Each value is the largest frame-to-frame brightness change in that bucket, on a scale of 0 to 255. videoscrub compares every source frame after scaling it to 64 pixels wide.

Peaks help locate visual changes. They do not identify actions or count events. Confirm them with `frames`.

## Downloads and cache

Video downloads begin when `frames` or `motion` needs them. Audio is downloaded separately if transcription needs it.

Overview downloads prefer video at 720p or lower, with a fallback to the best combined video and audio format. Cropping or setting `width` above 640 downloads the best available video. Later requests reuse that copy.

Cache files live under `$XDG_CACHE_HOME/videoscrub`, or `~/.cache/videoscrub` when that variable is unset. Replacing a local file invalidates its derived cache. Remote URLs are treated as stable.

Failed or cancelled downloads discard incomplete files. Simultaneous first requests can download independently. Requests pass cancellation to downloads, decoding, and transcription.
