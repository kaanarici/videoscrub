#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { version } from "../package.json";
import { frames, MAX_FRAMES, MAX_MOTION_SECONDS, MAX_SHEETS, motion } from "./frames";
import * as transcript from "./transcript";
import { hms, open } from "./video";

const source = z.string().describe("Local file path or http(s) URL (YouTube and other yt-dlp sites)");
const start_s = z.number().min(0).describe("Range start in seconds");
const end_s = z.number().min(0).describe("Range end in seconds");
const crop = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) })
  .refine((v) => v.x + v.width <= 1 && v.y + v.height <= 1, "Crop must fit inside the frame")
  .describe("Region in 0–1 coordinates, measured from the top left");
const annotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const server = new McpServer({ name: "videoscrub", version });

server.registerTool(
  "video_info",
  {
    description: "Return title, duration, dimensions, chapters, and transcript availability. Downloads media only if remote duration is missing.",
    annotations,
    inputSchema: { source },
  },
  async ({ source }, { signal }) => {
    const v = await open(source, signal);
    return text(JSON.stringify({ title: v.title, duration: hms(v.duration), duration_s: v.duration, width: v.width, height: v.height, fps: v.fps, transcript: await transcript.status(v), chapters: v.chapters }, null, 1));
  },
);

server.registerTool(
  "transcript",
  {
    description: "Read or search speech with timestamps and nearby context. Uses captions, or uploads audio to the configured transcription API.",
    annotations,
    inputSchema: { source, start_s: start_s.optional(), end_s: end_s.optional(), query: z.string().optional().describe("Substring to search for"), offset: z.number().int().nonnegative().optional().describe("Continuation offset from a previous result; keep the same source, range, and query") },
  },
  async ({ source, start_s, end_s, query, offset }, { signal }) => {
    const v = await open(source, signal);
    const { status, lines } = await transcript.lines(v, signal);
    if (!lines.length) return text(`Transcript ${status}.`);
    const page = transcript.format(lines, start_s, end_s, query, offset);
    const continuation = page.nextOffset === undefined ? "" : `\n\nMore results. Repeat the same request with offset=${page.nextOffset}.`;
    return text(page.text + continuation);
  },
);

server.registerTool(
  "frames",
  {
    description: `Inspect a video visually with up to ${MAX_FRAMES} timestamped frames on ${MAX_SHEETS} sheets. Source alone scans the whole video. Narrow the range for detail; crop or increase width for small text.`,
    annotations,
    inputSchema: {
      source,
      start_s: start_s.optional(),
      end_s: end_s.optional(),
      fps: z.number().positive().optional().describe("Frames per second. Omit to fit the range and width automatically, up to 1 fps"),
      width: z.number().int().min(160).max(1280).default(320).describe("Maximum frame width and height in pixels; 320 fits 16 per sheet, 640 fits 4, 1280 fits one"),
      crop: crop.optional(),
    },
  },
  async ({ source, start_s, end_s, fps, width, crop }, { signal }) => {
    const v = await open(source, signal);
    const { header, sheets } = await frames(v, start_s ?? 0, end_s ?? v.duration, fps, width, crop, signal);
    return { content: [{ type: "text" as const, text: header }, ...sheets.map((s) => ({ type: "image" as const, data: s.toString("base64"), mimeType: "image/jpeg" }))] };
  },
);

server.registerTool(
  "motion",
  {
    description: `Return up to 240 frame-to-frame luma-change buckets for a range of at most ${MAX_MOTION_SECONDS} seconds.`,
    annotations,
    inputSchema: { source, start_s, end_s },
  },
  async ({ source, start_s, end_s }, { signal }) => text((await motion(await open(source, signal), start_s, end_s, signal)).text),
);

await server.connect(new StdioServerTransport());
