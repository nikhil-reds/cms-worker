import { Injectable } from '@nestjs/common';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../../common/logger';
import type {
  MediaPosition,
  PlaylistRenderConfig,
  RenderResolution,
  RenderOutput,
  ResolvedItem,
} from './playlist-render.types';

const logger = createLogger('FfmpegRenderService');

/** Rendered duration may differ slightly from the sum of item durations. */
const DURATION_TOLERANCE_SEC = 2;

interface ProbeResult {
  durationSec: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

/**
 * Renders a playlist into a single MP4.
 *
 * Two stages:
 *  1. Normalize every item to a uniform MPEG-TS segment (same resolution,
 *     fps, H.264/AAC profile). Segments are cached by media id + duration +
 *     profile, so re-rendering after a one-item edit only re-encodes what
 *     changed.
 *  2. Concat the segments with the concat demuxer using stream copy — the
 *     expensive encode happens once per item, not once per playlist.
 */
@Injectable()
export class FfmpegRenderService {
  constructor(private config: PlaylistRenderConfig) {}

  private get segmentDir(): string {
    return join(this.config.scratchDir, 'segments');
  }

  private get workDir(): string {
    return join(this.config.scratchDir, 'work');
  }

  /** Profile string baked into segment cache keys — bump on encoder changes. */
  private profileKey(resolution: RenderResolution): string {
    const { width, height } = resolution;
    return `${width}x${height}-${this.config.fps}fps-${this.config.shortVideoBehavior}`;
  }

  /**
   * Render the resolved items (already sorted by position) into a single MP4
   * inside the scratch work dir. The caller installs it into the player.
   */
  async renderPlaylist(
    playlistId: string,
    items: ResolvedItem[],
    resolution: RenderResolution = this.config.resolution,
  ): Promise<RenderOutput> {
    mkdirSync(this.segmentDir, { recursive: true });
    mkdirSync(this.workDir, { recursive: true });

    const segments: string[] = [];
    for (const item of items) {
      segments.push(await this.normalizeItem(item, resolution));
    }

    const listPath = join(this.workDir, `${playlistId}.txt`);
    writeFileSync(
      listPath,
      segments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join('\n') +
        '\n',
      'utf-8',
    );

    const outputPath = join(this.workDir, `${playlistId}.mp4`);
    logger.info(`Concatenating ${segments.length} segment(s) → ${outputPath}`);

    await this.runFfmpeg([
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-c',
      'copy',
      '-bsf:a',
      'aac_adtstoasc',
      '-movflags',
      '+faststart',
      outputPath,
    ]);

    const probe = await this.probe(outputPath);
    const expectedSec = items.reduce((sum, item) => sum + item.durationSec, 0);

    if (!probe.hasVideo || probe.durationSec <= 0) {
      throw new Error(
        `Rendered file is invalid (video=${probe.hasVideo}, duration=${probe.durationSec}s)`,
      );
    }
    // Longer than expected means the concat glued something wrong; shorter is
    // legitimate ('natural' short videos, skipped frames).
    if (probe.durationSec > expectedSec + DURATION_TOLERANCE_SEC) {
      throw new Error(
        `Rendered duration ${probe.durationSec}s exceeds expected ${expectedSec}s beyond tolerance`,
      );
    }

    return { outputPath, durationSec: Math.round(probe.durationSec) };
  }

  /**
   * Normalize one playlist item into a cached uniform segment.
   */
  private async normalizeItem(item: ResolvedItem, resolution: RenderResolution): Promise<string> {
    const segmentPath = join(
      this.segmentDir,
      `${item.mediaId}-${item.durationSec}s-${item.fit}-${item.objectPosition}-${this.profileKey(resolution)}.ts`,
    );

    if (existsSync(segmentPath)) {
      logger.debug(`Segment cache hit: ${segmentPath}`);
      return segmentPath;
    }

    logger.info(
      `Encoding segment: ${item.kind} ${item.localPath} (${item.durationSec}s)`,
    );

    const args =
      item.kind === 'image'
        ? this.imageArgs(item, segmentPath, resolution)
        : item.kind === 'audio'
          ? this.audioArgs(item, segmentPath, resolution)
          : this.videoArgs(item, segmentPath, await this.probe(item.localPath), resolution);

    // Encode to a tmp name, then rename, so a crash mid-encode never leaves
    // a truncated segment behind for the cache to reuse.
    const tmpPath = `${segmentPath}.tmp.ts`;
    await this.runFfmpeg([...args.slice(0, -1), tmpPath]);
    renameSync(tmpPath, segmentPath);

    return segmentPath;
  }

  private layoutFilter(item: ResolvedItem, resolution: RenderResolution): string {
    const { width, height } = resolution;
    const cropX = this.positionExpr(item.objectPosition, 'crop-x');
    const cropY = this.positionExpr(item.objectPosition, 'crop-y');
    const padX = this.positionExpr(item.objectPosition, 'pad-x');
    const padY = this.positionExpr(item.objectPosition, 'pad-y');
    const finish = `fps=${this.config.fps},format=yuv420p`;

    if (item.fit === 'fill') {
      return `scale=${width}:${height},${finish}`;
    }

    if (item.fit === 'cover') {
      return (
        `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
        `crop=${width}:${height}:${cropX}:${cropY},${finish}`
      );
    }

    if (item.fit === 'none') {
      return (
        `crop=w='min(iw\\,${width})':h='min(ih\\,${height})':x=${cropX}:y=${cropY},` +
        `pad=${width}:${height}:${padX}:${padY}:color=black,${finish}`
      );
    }

    if (item.fit === 'scale-down') {
      return (
        `scale=w='min(iw\\,${width})':h='min(ih\\,${height})':` +
        `force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:${padX}:${padY}:color=black,${finish}`
      );
    }

    return (
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:${padX}:${padY}:color=black,${finish}`
    );
  }

  private positionExpr(
    position: MediaPosition,
    mode: 'crop-x' | 'crop-y' | 'pad-x' | 'pad-y',
  ): string {
    const isX = mode.endsWith('x');
    if (isX) {
      if (position === 'left') return '0';
      if (position === 'right') return mode.startsWith('crop') ? 'iw-ow' : 'ow-iw';
      return mode.startsWith('crop') ? '(iw-ow)/2' : '(ow-iw)/2';
    }

    if (position === 'top') return '0';
    if (position === 'bottom') return mode.startsWith('crop') ? 'ih-oh' : 'oh-ih';
    return mode.startsWith('crop') ? '(ih-oh)/2' : '(oh-ih)/2';
  }

  private get videoCodecArgs(): string[] {
    return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'];
  }

  private get audioCodecArgs(): string[] {
    return ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'];
  }

  private static readonly SILENT_AUDIO =
    'anullsrc=channel_layout=stereo:sample_rate=48000';

  /** Still image shown for durationSec, with a silent audio track so every
   *  segment has identical stream layout for the concat stream copy. */
  private imageArgs(
    item: ResolvedItem,
    out: string,
    resolution: RenderResolution,
  ): string[] {
    return [
      '-y',
      '-loop',
      '1',
      '-framerate',
      String(this.config.fps),
      '-t',
      String(item.durationSec),
      '-i',
      item.localPath,
      '-f',
      'lavfi',
      '-t',
      String(item.durationSec),
      '-i',
      FfmpegRenderService.SILENT_AUDIO,
      '-vf',
      this.layoutFilter(item, resolution),
      ...this.videoCodecArgs,
      ...this.audioCodecArgs,
      '-shortest',
      '-f',
      'mpegts',
      out,
    ];
  }

  /** Audio file over a black background frame. */
  private audioArgs(
    item: ResolvedItem,
    out: string,
    resolution: RenderResolution,
  ): string[] {
    const { width, height } = resolution;
    return [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=black:s=${width}x${height}:r=${this.config.fps}`,
      '-i',
      item.localPath,
      '-t',
      String(item.durationSec),
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-vf',
      `format=yuv420p`,
      ...this.videoCodecArgs,
      ...this.audioCodecArgs,
      '-shortest',
      '-f',
      'mpegts',
      out,
    ];
  }

  /** Video trimmed to durationSec; short sources either end naturally or loop
   *  to fill, per config. Sources without audio get a silent track. */
  private videoArgs(
    item: ResolvedItem,
    out: string,
    probe: ProbeResult,
    resolution: RenderResolution,
  ): string[] {
    const loop =
      this.config.shortVideoBehavior === 'loop' &&
      probe.durationSec < item.durationSec;

    const inputArgs = [
      ...(loop ? ['-stream_loop', '-1'] : []),
      '-i',
      item.localPath,
    ];

    if (probe.hasAudio) {
      return [
        '-y',
        ...inputArgs,
        '-t',
        String(item.durationSec),
        '-vf',
        this.layoutFilter(item, resolution),
        ...this.videoCodecArgs,
        ...this.audioCodecArgs,
        '-f',
        'mpegts',
        out,
      ];
    }

    return [
      '-y',
      ...inputArgs,
      '-f',
      'lavfi',
      '-i',
      FfmpegRenderService.SILENT_AUDIO,
      '-t',
      String(item.durationSec),
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-vf',
      this.layoutFilter(item, resolution),
      ...this.videoCodecArgs,
      ...this.audioCodecArgs,
      ...(loop ? [] : ['-shortest']),
      '-f',
      'mpegts',
      out,
    ];
  }

  async probe(filePath: string): Promise<ProbeResult> {
    const output = await this.run(this.config.ffprobePath, [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);

    const parsed = JSON.parse(output);
    const streams: any[] = parsed.streams ?? [];

    return {
      durationSec: parseFloat(parsed.format?.duration ?? '0') || 0,
      hasAudio: streams.some((s) => s.codec_type === 'audio'),
      hasVideo: streams.some((s) => s.codec_type === 'video'),
    };
  }

  private runFfmpeg(args: string[]): Promise<string> {
    return this.run(this.config.ffmpegPath, args);
  }

  private run(binary: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));

      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          // ffmpeg puts diagnostics on stderr; keep the tail, it has the error
          const tail = stderr.split('\n').slice(-8).join('\n');
          reject(
            new Error(
              `${binary.split('/').pop()} exited with code ${code}:\n${tail}`,
            ),
          );
        }
      });
    });
  }
}
