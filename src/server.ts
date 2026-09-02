#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { frames, MAX_FRAMES, MAX_MOTION_SECONDS, motion } from "./frames";
import * as transcript from "./transcript";
import { hms, open } from "./video";

const source = z.string().describe("Local file path or http(s) URL (YouTube and other yt-dlp sites)");
const start_s = z.number().min(0).describe("Range start in seconds");
const end_s = z.number().min(0).describe("Range end in seconds");
const annotations = { readOnlyHint: true };
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const server = new McpServer({ name: "videoscrub", version: "0.1.0" });

server.registerTool(
  "video_info",
  {
    description: "Open a video and return its title, duration, dimensions, chapters, and transcript status. Call this first; it downloads and caches remote videos.",
    annotations,
    inputSchema: { source },
  },
  async ({ source }) => {
    const v = await open(source);
    return text(JSON.stringify({ title: v.title, duration: hms(v.duration), duration_s: v.duration, width: v.width, height: v.height, fps: v.fps, transcript: await transcript.status(v), chapters: v.chapters }, null, 1));
  },
);

server.registerTool(
  "transcript",
  {
    description: "Timestamped transcript lines, optionally limited to a time range and/or filtered by a case-insensitive query (matches come with 2 lines of context). Uses captions when the video has them, otherwise transcribes the audio with whisper on first use, which can take a while; if the result says transcribing, call again. Cheap: search here first whenever the answer may be spoken, then confirm with frames.",
    annotations,
    inputSchema: { source, start_s: start_s.optional(), end_s: end_s.optional(), query: z.string().optional().describe("Substring to search for") },
  },
  async ({ source, start_s, end_s, query }) => {
    const v = await open(source);
    const { status, lines } = await transcript.lines(v);
    return text(lines.length ? transcript.format(lines, start_s, end_s, query) : `Transcript ${status}.`);
  },
);

server.registerTool(
  "frames",
  {
    description: `Sample frames from a time range at a chosen fps and return them as contact sheets (tiles in row order; the text lists each tile's timestamp). At most ${MAX_FRAMES} frames per call. Strategy: scan wide at fps 0.2-0.5 and width 320 to find candidate moments, then re-call narrow windows at fps 2-10 and width 640-1280 to inspect fast actions, count events, or read details.`,
    annotations,
    inputSchema: {
      source,
      start_s,
      end_s,
      fps: z.number().min(0.05).max(60).default(1).describe("Frames per second to sample, capped at the video's frame rate"),
      width: z.number().int().min(160).max(1280).default(320).describe("Width of each frame in pixels; 320 fits 16 per sheet, 640 fits 4, 1280 is one full frame per sheet"),
    },
  },
  async ({ source, start_s, end_s, fps, width }) => {
    const v = await open(source);
    const { header, sheets } = await frames(v, start_s, end_s, fps, width);
    return { content: [{ type: "text" as const, text: header }, ...sheets.map((s) => ({ type: "image" as const, data: s.toString("base64"), mimeType: "image/jpeg" }))] };
  },
);

server.registerTool(
  "motion",
  {
    description: `Motion timeline for a time range, text only: one number per bucket (up to 240) giving the largest frame-to-frame change, computed from every source frame so nothing is missed. Use it to count repeated actions (periodic bumps), find cuts, flashes, or anomalies (isolated spikes), or see when something starts or stops moving, then confirm with frames at the times it points to. At most ${MAX_MOTION_SECONDS} s per call.`,
    annotations,
    inputSchema: { source, start_s, end_s },
  },
  async ({ source, start_s, end_s }) => text((await motion(await open(source), start_s, end_s)).text),
);

await server.connect(new StdioServerTransport());
