import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  VideoCheckSchema,
  videoSteps,
  type CheckCategory,
  type VideoCheckResult,
  type VideoStep,
} from "@ishonch/shared";
import type { AiService } from "../../ai/aiService.js";

const run = promisify(execFile);
/** How many stills the AI gets from a clip and how big they are: enough to read a *#06# screen, cheap to send. */
const FRAMES = 5;
const FRAME_WIDTH = 768;
const FFMPEG_TIMEOUT_MS = 20_000;

export interface VideoFrames {
  jpegs: Buffer[];
  seconds: number | null;
}

/**
 * MP4 / MOV carry an `ftyp` box in the first bytes, WebM (Matroska) starts with its EBML magic. Anything else
 * is not a clip we can read, and ffprobe would scan the whole file for a header before giving up.
 */
export function looksLikeVideo(data: Buffer): boolean {
  if (data.length < 12) return false;
  if (data.subarray(4, 8).toString("latin1") === "ftyp") return true;
  return data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3;
}

/** Clip length in seconds via ffprobe; null when ffprobe is missing or the file is not a video. */
async function duration(path: string): Promise<number | null> {
  try {
    const { stdout } = await run(
      "ffprobe",
      ["-v", "error", "-probesize", "5000000", "-analyzeduration", "5000000", "-show_entries", "format=duration", "-of", "csv=p=0", path],
      { timeout: FFMPEG_TIMEOUT_MS },
    );
    const s = Number.parseFloat(stdout.trim());
    return Number.isFinite(s) && s > 0 ? s : null;
  } catch {
    return null;
  }
}

/**
 * Stills taken evenly across the clip (ffmpeg). The whole step is best-effort: without ffmpeg, or with a file
 * that is not really a video, it returns no frames and the check ends as `unknown` instead of failing the upload.
 */
export async function extractFrames(video: Buffer, ext: string): Promise<VideoFrames> {
  if (!looksLikeVideo(video)) return { jpegs: [], seconds: null };
  const dir = await mkdtemp(join(tmpdir(), "ishonch-video-"));
  try {
    const src = join(dir, `clip.${ext}`);
    await writeFile(src, video);
    const seconds = await duration(src);
    if (seconds === null) return { jpegs: [], seconds: null };
    const jpegs: Buffer[] = [];
    for (let i = 0; i < FRAMES; i++) {
      // 10 %, 30 %, 50 %, 70 %, 90 % of the clip: the script's steps follow each other, the ends are usually the body.
      const at = Math.min(seconds * ((i + 0.5) / FRAMES), Math.max(seconds - 0.2, 0));
      const out = join(dir, `f${i}.jpg`);
      try {
        await run(
          "ffmpeg",
          ["-v", "error", "-y", "-ss", at.toFixed(2), "-i", src, "-frames:v", "1", "-vf", `scale='min(${FRAME_WIDTH},iw)':-2`, "-q:v", "4", out],
          { timeout: FFMPEG_TIMEOUT_MS },
        );
        jpegs.push(await readFile(out));
      } catch {
        /* a frame we could not take is skipped */
      }
    }
    return { jpegs, seconds };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export const unknownCheck = (seconds: number | null = null): VideoCheckResult => ({
  verdict: "unknown",
  seen: [],
  noteRu: "",
  noteUz: "",
  seconds,
  at: new Date().toISOString(),
});

/**
 * The AI reads the frames against the script of the category. `pass`: the device is on and every step the
 * category asks for is there; `warn`: the device is on but steps are missing (the seller is asked to re-shoot,
 * the buyer sees what is missing); `fail`: no working device of that category is visible at all.
 */
export async function checkVideo(
  ai: Pick<AiService, "structured">,
  frames: VideoFrames,
  listing: { category: CheckCategory; title: string },
): Promise<VideoCheckResult> {
  if (!frames.jpegs.length) return unknownCheck(frames.seconds);
  const content: Parameters<AiService["structured"]>[0]["content"] = frames.jpegs.map((img) => ({
    type: "image" as const,
    source: { type: "base64" as const, media_type: "image/jpeg" as const, data: img.toString("base64") },
  }));
  content.push({ type: "text", text: JSON.stringify({ category: listing.category, title: listing.title, frames: frames.jpegs.length, seconds: frames.seconds }) });
  const { data } = await ai.structured({ feature: "listing.video_check", promptId: "video_check", content, schema: VideoCheckSchema });

  const seen: VideoStep[] = [];
  if (data.device_visible && data.powered_on) seen.push("device_on");
  if (data.identifier_screen) seen.push("identifier");
  if (data.battery_screen) seen.push("battery");
  if (data.account_screen) seen.push("account");
  if (data.body_shown) seen.push("body");
  const wanted = videoSteps(listing.category);
  const verdict: VideoCheckResult["verdict"] = !data.device_visible || !data.powered_on
    ? "fail"
    : wanted.every((s) => seen.includes(s)) && data.screen_damage !== "major"
      ? "pass"
      : "warn";
  const concerns = data.concerns.slice(0, 3).join("; ");
  const tail = data.imei_tail.replace(/\D/g, "");
  return {
    verdict,
    imeiTailRead: data.identifier_screen && tail.length >= 4 ? tail.slice(-4) : null,
    seen: seen.filter((s) => wanted.includes(s)),
    noteRu: [data.note_ru.trim(), concerns].filter(Boolean).join(" ").slice(0, 300),
    noteUz: data.note_uz.trim().slice(0, 300),
    seconds: frames.seconds,
    at: new Date().toISOString(),
  };
}
