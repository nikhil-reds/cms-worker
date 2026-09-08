import { homedir, tmpdir } from 'os';
import { join } from 'path';

export function defaultPlayerRootPath(): string {
  return process.platform === 'win32'
    ? join(homedir(), 'Desktop', 'player')
    : '/Users/nikhil/Desktop/player';
}

export function defaultScratchDir(): string {
  return join(tmpdir(), 'cms-worker', 'renders');
}

export function defaultRemotePlayerMediaRootPath(): string {
  return join(tmpdir(), 'cms-worker', 'player-media');
}

export function resolvePlayerRootPath(value?: string): string {
  if (!value || isInvalidWindowsUsersRoot(value)) {
    return defaultPlayerRootPath();
  }

  return value;
}

export function resolvePlayerMediaRootPath(
  value: string | undefined,
  playerRootPath: string,
  playerApiUrl: string,
): string {
  if (value && !isInvalidWindowsUsersRoot(value)) {
    return value;
  }

  return playerApiUrl
    ? defaultRemotePlayerMediaRootPath()
    : join(playerRootPath, 'media');
}

function isInvalidWindowsUsersRoot(value: string): boolean {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' && normalized === '/Users';
}
