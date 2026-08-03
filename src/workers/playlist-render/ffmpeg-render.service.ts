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
  RenderZone,
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

interface PixelZone {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
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
    zones: RenderZone[] = [],
  ): Promise<RenderOutput> {
    mkdirSync(this.segmentDir, { recursive: true });
    mkdirSync(this.workDir, { recursive: true });

    const hasZoneLayout = items.some(
      (item) => item.zoneId && item.zoneId !== 'full-screen',
    );

    if (hasZoneLayout) {
      return this.renderZonedPlaylist(playlistId, items, resolution, zones);
    }

    const segments: string[] = [];
    for (const item of items) {
      segments.push(await this.normalizeItem(item, resolution));
    }

    const outputPath = join(this.workDir, `${playlistId}.mp4`);
    await this.concatSegments(playlistId, segments, outputPath);

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

  private async renderZonedPlaylist(
    playlistId: string,
    items: ResolvedItem[],
    resolution: RenderResolution,
    zones: RenderZone[],
  ): Promise<RenderOutput> {
    const zoneById = this.resolveZones(zones, resolution);
    const grouped = new Map<string, ResolvedItem[]>();
    for (const item of items) {
      const zoneId = item.zoneId || 'full-screen';
      grouped.set(zoneId, [...(grouped.get(zoneId) ?? []), item]);
    }

    const laneVideos: Array<{
      zone: PixelZone;
      path: string;
      durationSec: number;
    }> = [];
    for (const [zoneId, laneItems] of grouped) {
      const zone = zoneById.get(zoneId) ?? zoneById.get('full-screen')!;
      const zoneResolution = { width: zone.width, height: zone.height };
      const segments: string[] = [];
      for (const item of laneItems) {
        segments.push(await this.normalizeItem(item, zoneResolution));
      }

      const lanePath = join(this.workDir, `${playlistId}-${zoneId}.mp4`);
      await this.concatSegments(`${playlistId}-${zoneId}`, segments, lanePath);
      laneVideos.push({
        zone,
        path: lanePath,
        durationSec: laneItems.reduce((sum, item) => sum + item.durationSec, 0),
      });
    }
    laneVideos.sort((a, b) => {
      const areaA = a.zone.width * a.zone.height;
      const areaB = b.zone.width * b.zone.height;
      return areaB - areaA;
    });

    const outputPath = join(this.workDir, `${playlistId}.mp4`);
    const expectedSec = Math.max(...laneVideos.map((lane) => lane.durationSec));
    logger.info(
      `Compositing ${laneVideos.length} zone lane(s) → ${outputPath} (${expectedSec}s)`,
    );

    const args = [
      '-y',
      '-f',
      'lavfi',
      '-t',
      String(expectedSec),
      '-i',
      `color=c=black:s=${resolution.width}x${resolution.height}:r=${this.config.fps}`,
      '-f',
      'lavfi',
      '-t',
      String(expectedSec),
      '-i',
      FfmpegRenderService.SILENT_AUDIO,
      ...laneVideos.flatMap((lane) => ['-stream_loop', '-1', '-i', lane.path]),
      '-filter_complex',
      this.zoneOverlayFilter(laneVideos),
      '-map',
      '[vout]',
      '-map',
      '1:a:0',
      '-t',
      String(expectedSec),
      ...this.videoCodecArgs,
      ...this.audioCodecArgs,
      '-movflags',
      '+faststart',
      outputPath,
    ];

    await this.runFfmpeg(args);

    const probe = await this.probe(outputPath);
    if (!probe.hasVideo || probe.durationSec <= 0) {
      throw new Error(
        `Rendered zoned file is invalid (video=${probe.hasVideo}, duration=${probe.durationSec}s)`,
      );
    }
    if (probe.durationSec > expectedSec + DURATION_TOLERANCE_SEC) {
      throw new Error(
        `Rendered zoned duration ${probe.durationSec}s exceeds expected ${expectedSec}s beyond tolerance`,
      );
    }

    return { outputPath, durationSec: Math.round(probe.durationSec) };
  }

  private async concatSegments(
    playlistId: string,
    segments: string[],
    outputPath: string,
  ): Promise<void> {
    const listPath = join(this.workDir, `${playlistId}.txt`);
    writeFileSync(
      listPath,
      segments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join('\n') +
        '\n',
      'utf-8',
    );

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
  }

  private zoneOverlayFilter(lanes: Array<{ zone: PixelZone }>): string {
    let previous = '0:v';
    const filters: string[] = [];
    lanes.forEach((lane, index) => {
      const input = `${index + 2}:v`;
      const output = index === lanes.length - 1 ? 'vout' : `v${index}`;
      filters.push(
        `[${previous}][${input}]overlay=${lane.zone.x}:${lane.zone.y}:shortest=0:eof_action=pass[${output}]`,
      );
      previous = output;
    });
    return filters.join(';');
  }

  private resolveZones(
    zones: RenderZone[],
    resolution: RenderResolution,
  ): Map<string, PixelZone> {
    const defaults: RenderZone[] = [
      { id: 'full-screen', name: 'Full Screen', x: 0, y: 0, w: 100, h: 100 },
      { id: 'top-banner', name: 'Top Banner', x: 0, y: 0, w: 100, h: 22 },
      {
        id: 'bottom-banner',
        name: 'Bottom Banner',
        x: 0,
        y: 78,
        w: 100,
        h: 22,
      },
      { id: 'left-panel', name: 'Left Panel', x: 0, y: 0, w: 32, h: 100 },
      { id: 'center-panel', name: 'Center Panel', x: 32, y: 0, w: 36, h: 100 },
      { id: 'right-panel', name: 'Right Panel', x: 68, y: 0, w: 32, h: 100 },
      { id: 'main-area', name: 'Main Area', x: 32, y: 0, w: 68, h: 100 },
      { id: 'middle-left', name: 'Middle Left', x: 0, y: 22, w: 32, h: 56 },
      { id: 'middle', name: 'Middle', x: 32, y: 22, w: 36, h: 56 },
      { id: 'middle-right', name: 'Middle Right', x: 68, y: 22, w: 32, h: 56 },
      { id: 'left-top', name: 'Left Top', x: 0, y: 0, w: 32, h: 33.333 },
      {
        id: 'left-center',
        name: 'Left Center',
        x: 0,
        y: 33.333,
        w: 32,
        h: 33.334,
      },
      {
        id: 'left-bottom',
        name: 'Left Bottom',
        x: 0,
        y: 66.667,
        w: 32,
        h: 33.333,
      },
      { id: 'center-top', name: 'Center Top', x: 32, y: 0, w: 36, h: 33.333 },
      {
        id: 'center-bottom',
        name: 'Center Bottom',
        x: 32,
        y: 66.667,
        w: 36,
        h: 33.333,
      },
      { id: 'right-top', name: 'Right Top', x: 68, y: 0, w: 32, h: 33.333 },
      {
        id: 'right-center',
        name: 'Right Center',
        x: 68,
        y: 33.333,
        w: 32,
        h: 33.334,
      },
      {
        id: 'right-bottom',
        name: 'Right Bottom',
        x: 68,
        y: 66.667,
        w: 32,
        h: 33.333,
      },
      {
        id: 'main-area-left',
        name: 'Main Area Left',
        x: 32,
        y: 0,
        w: 34,
        h: 100,
      },
      {
        id: 'main-area-right',
        name: 'Main Area Right',
        x: 66,
        y: 0,
        w: 34,
        h: 100,
      },
    ];

    const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

    return new Map(
      [...defaults, ...zones].map((zone) => [
        zone.id,
        {
          id: zone.id,
          name: zone.name,
          x: Math.round((zone.x / 100) * resolution.width),
          y: Math.round((zone.y / 100) * resolution.height),
          width: even((zone.w / 100) * resolution.width),
          height: even((zone.h / 100) * resolution.height),
        },
      ]),
    );
  }

  /**
   * Normalize one playlist item into a cached uniform segment.
   */
  private async normalizeItem(
    item: ResolvedItem,
    resolution: RenderResolution,
  ): Promise<string> {
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
          : this.videoArgs(
              item,
              segmentPath,
              await this.probe(item.localPath),
              resolution,
            );

    // Encode to a tmp name, then rename, so a crash mid-encode never leaves
    // a truncated segment behind for the cache to reuse.
    const tmpPath = `${segmentPath}.tmp.ts`;
    await this.runFfmpeg([...args.slice(0, -1), tmpPath]);
    renameSync(tmpPath, segmentPath);

    return segmentPath;
  }

  private layoutFilter(
    item: ResolvedItem,
    resolution: RenderResolution,
  ): string {
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
      if (position === 'right')
        return mode.startsWith('crop') ? 'iw-ow' : 'ow-iw';
      return mode.startsWith('crop') ? '(iw-ow)/2' : '(ow-iw)/2';
    }

    if (position === 'top') return '0';
    if (position === 'bottom')
      return mode.startsWith('crop') ? 'ih-oh' : 'oh-ih';
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
