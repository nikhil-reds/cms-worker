/**
 * Smoke test for the playlist-render ffmpeg pipeline. No DB or S3 needed —
 * it generates a test image, a video with audio, and a silent video, renders
 * them as a 3-item playlist, and validates the output.
 *
 * Run: npm run smoke:render
 */
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FfmpegRenderService } from '../src/workers/playlist-render/ffmpeg-render.service';
import type {
  PlaylistRenderConfig,
  ResolvedItem,
} from '../src/workers/playlist-render/playlist-render.types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath: string = require('ffmpeg-static');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffprobePath: string = require('ffprobe-static').path;

const SCRATCH = join(tmpdir(), 'cms-worker-render-smoke');

async function main() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });

  const img = join(SCRATCH, 'test.png');
  const vidAudio = join(SCRATCH, 'test-audio.mp4');
  const vidSilent = join(SCRATCH, 'test-silent.mp4');

  // 640x360 test image
  execFileSync(ffmpegPath, [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=640x360:rate=1',
    '-frames:v',
    '1',
    img,
  ]);
  // 4s 720x480 video WITH audio
  execFileSync(ffmpegPath, [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=720x480:rate=25:duration=4',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=4',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    '-shortest',
    vidAudio,
  ]);
  // 3s video WITHOUT audio
  execFileSync(ffmpegPath, [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1280x720:rate=30:duration=3',
    '-c:v',
    'libx264',
    vidSilent,
  ]);

  const config: PlaylistRenderConfig = {
    playerRootPath: SCRATCH,
    playerMediaRootPath: join(SCRATCH, 'media'),
    mediaBucket: '',
    playlistBucket: '',
    processedBucket: '',
    pollIntervalMs: 30000,
    resolution: { width: 1280, height: 720 },
    fps: 30,
    playerConfigMode: 'append',
    shortVideoBehavior: 'natural',
    scratchDir: SCRATCH,
    ffmpegPath,
    ffprobePath,
  };

  const renderer = new FfmpegRenderService(config);

  const items: ResolvedItem[] = [
    {
      mediaId: 'img-1',
      position: 0,
      durationSec: 3,
      fit: 'scale-down',
      objectPosition: 'center',
      kind: 'image',
      localPath: img,
    },
    {
      mediaId: 'vid-audio-1',
      position: 1,
      durationSec: 4,
      fit: 'scale-down',
      objectPosition: 'center',
      kind: 'video',
      localPath: vidAudio,
    },
    {
      mediaId: 'vid-silent-1',
      position: 2,
      durationSec: 3,
      fit: 'scale-down',
      objectPosition: 'center',
      kind: 'video',
      localPath: vidSilent,
    },
  ];

  const result = await renderer.renderPlaylist('smoke-test-playlist', items);
  console.log('RENDER OK:', result);

  const probe = await renderer.probe(result.outputPath);
  console.log('OUTPUT PROBE:', probe);

  if (Math.abs(probe.durationSec - 10) > 2)
    throw new Error(`Unexpected duration ${probe.durationSec}`);
  if (!probe.hasAudio || !probe.hasVideo)
    throw new Error('Missing stream in output');

  // Re-render to prove the segment cache works (should be near-instant)
  const t = Date.now();
  await renderer.renderPlaylist('smoke-test-playlist', items);
  console.log(`RE-RENDER (cached segments) took ${Date.now() - t}ms`);

  console.log('SMOKE TEST PASSED');
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
