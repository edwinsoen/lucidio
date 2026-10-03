import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import sharp from 'sharp';

// ffmpeg-static ships a CommonJS module whose export is the binary path string; under
// NodeNext the default import is typed as the module namespace, so normalize it here.
const ffmpegPath = ffmpegStatic as unknown as string | null;

const THUMBNAIL_MAX_EDGE_PX = 320;
const THUMBNAIL_WEBP_QUALITY = 78;
const FFMPEG_TIMEOUT_MS = 30_000;

export interface VideoThumbnail {
  bytes: Buffer;
  contentType: 'image/webp';
  width?: number;
  height?: number;
}

/**
 * Extract the first frame of an MP4 and encode it as a resized webp thumbnail.
 * Gemini video models (Veo, Omni Flash) return only an MP4 with no accompanying
 * thumbnail image, unlike BytePlus which returns a last-frame image, so Lucidio
 * derives the thumbnail here. Uses the bundled `ffmpeg-static` binary (no system
 * ffmpeg dependency) followed by the same sharp -> webp pipeline used for image
 * thumbnails in the API layer.
 */
export async function extractVideoThumbnail(mp4Bytes: Buffer): Promise<VideoThumbnail> {
  const frame = await extractFirstFramePng(mp4Bytes);
  const image = sharp(frame, { failOn: 'none' }).rotate().resize({
    width: THUMBNAIL_MAX_EDGE_PX,
    height: THUMBNAIL_MAX_EDGE_PX,
    fit: 'inside',
    withoutEnlargement: true
  }).webp({ quality: THUMBNAIL_WEBP_QUALITY });
  const { data, info } = await image.toBuffer({ resolveWithObject: true });
  return { bytes: data, contentType: 'image/webp', width: info.width, height: info.height };
}

async function extractFirstFramePng(mp4Bytes: Buffer): Promise<Buffer> {
  if (!ffmpegPath) throw new Error('ffmpeg-static binary path is unavailable.');
  // Write to a temp file: MP4 first-frame extraction is unreliable over a non-seekable stdin pipe.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidio-thumb-'));
  const input = path.join(dir, `${randomBytes(8).toString('hex')}.mp4`);
  try {
    await fs.writeFile(input, mp4Bytes);
    return await runFfmpegFirstFrame(ffmpegPath, input);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runFfmpegFirstFrame(binary: string, inputPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = ['-nostdin', '-loglevel', 'error', '-i', inputPath, '-frames:v', '1', '-f', 'image2', '-c:v', 'png', 'pipe:1'];
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Video thumbnail extraction timed out.'));
    }, FFMPEG_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Video thumbnail extraction failed to start: ${error instanceof Error ? error.message : String(error)}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks);
      if (code !== 0 || output.length === 0) {
        const detail = Buffer.concat(errChunks).toString('utf8').slice(0, 300).trim();
        return reject(new Error(`Video thumbnail extraction failed (exit ${code ?? 'null'})${detail ? `: ${detail}` : ''}.`));
      }
      resolve(output);
    });
  });
}
