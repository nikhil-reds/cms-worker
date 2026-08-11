import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { createServer, type Server } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import { createLogger } from '../common/logger';

const logger = createLogger('PlayerWebSocketGatewayService');

interface PlayerSocketState {
  deviceId: string;
  tenantId?: string;
  siteId?: string;
  groupId?: string;
  connectedAt: string;
  lastPongAt: number;
  socket: WebSocket;
}

interface ManifestUpdatedMessage {
  schemaVersion: 1;
  type: 'manifest.updated';
  eventId: string;
  deviceId: string;
  manifestUrl: string;
  manifestRevision: string;
  contentHash: string;
  publishedAt: string;
}

@Injectable()
export class PlayerWebSocketGatewayService implements OnApplicationShutdown {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private readonly players = new Map<string, PlayerSocketState>();
  private readonly tenants = new Map<string, Set<string>>();
  private readonly sites = new Map<string, Set<string>>();
  private readonly groups = new Map<string, Set<string>>();

  constructor(
    private readonly port: number,
    private readonly path: string,
    private readonly token: string,
    private readonly heartbeatMs: number,
    private readonly enabled = false,
  ) {}

  async start(): Promise<void> {
    if (!this.enabled) {
      logger.info('Player WebSocket gateway disabled');
      return;
    }

    this.server = createServer();
    this.wss = new WebSocketServer({
      server: this.server,
      path: this.path,
    });

    this.wss.on('connection', (socket, request) => {
      const url = new URL(request.url || this.path, `http://${request.headers.host}`);
      const deviceId = url.searchParams.get('deviceId') || '';
      const tenantId = url.searchParams.get('tenantId') || undefined;
      const siteId = url.searchParams.get('siteId') || undefined;
      const groupId = url.searchParams.get('groupId') || undefined;
      const token = url.searchParams.get('token') || request.headers.authorization?.replace(/^Bearer\s+/i, '') || '';

      if (!deviceId || (this.token && token !== this.token)) {
        socket.close(1008, 'Unauthorized');
        return;
      }

      this.registerPlayer({ deviceId, tenantId, siteId, groupId }, socket);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        this.server?.off('listening', onListening);
        reject(
          error.code === 'EADDRINUSE'
            ? new Error(`Player WebSocket gateway port ${this.port} is already in use. Set PLAYER_WS_PORT to a free port.`)
            : error,
        );
      };
      const onListening = () => {
        this.server?.off('error', onError);
        resolve();
      };

      this.server?.once('error', onError);
      this.server?.once('listening', onListening);
      this.server?.listen(this.port);
    });

    this.heartbeatInterval = setInterval(() => this.checkHeartbeats(), this.heartbeatMs);
    logger.info(`Player WebSocket gateway listening on ${this.path} port ${this.port}`);
  }

  notifyManifestUpdated(message: ManifestUpdatedMessage): boolean {
    const state = this.players.get(message.deviceId);
    if (!state || state.socket.readyState !== state.socket.OPEN) {
      logger.warn(`Player ${message.deviceId} is not connected for manifest update`);
      return false;
    }

    state.socket.send(JSON.stringify(message));
    logger.info(`Sent manifest.updated to player ${message.deviceId}`);
    return true;
  }

  notifyTenant(tenantId: string, message: Omit<ManifestUpdatedMessage, 'deviceId'>): number {
    return this.notifyIndex(this.tenants, tenantId, message);
  }

  notifySite(siteId: string, message: Omit<ManifestUpdatedMessage, 'deviceId'>): number {
    return this.notifyIndex(this.sites, siteId, message);
  }

  notifyGroup(groupId: string, message: Omit<ManifestUpdatedMessage, 'deviceId'>): number {
    return this.notifyIndex(this.groups, groupId, message);
  }

  metrics(): { connectedPlayers: number; deviceIds: string[] } {
    return {
      connectedPlayers: this.players.size,
      deviceIds: [...this.players.keys()],
    };
  }

  private registerPlayer(
    identity: {
      deviceId: string;
      tenantId?: string;
      siteId?: string;
      groupId?: string;
    },
    socket: WebSocket,
  ): void {
    const { deviceId, tenantId, siteId, groupId } = identity;
    const existing = this.players.get(deviceId);
    if (existing && existing.socket.readyState === existing.socket.OPEN) {
      existing.socket.close(1000, 'Replaced by newer connection');
    }

    const state: PlayerSocketState = {
      deviceId,
      tenantId,
      siteId,
      groupId,
      connectedAt: new Date().toISOString(),
      lastPongAt: Date.now(),
      socket,
    };

    socket.on('pong', () => {
      state.lastPongAt = Date.now();
    });

    socket.on('message', (raw) => {
      logger.info(`Player ${deviceId} message: ${raw.toString()}`);
    });

    socket.on('close', () => {
      if (this.players.get(deviceId)?.socket === socket) {
        this.players.delete(deviceId);
        this.removeFromIndexes(state);
      }
      logger.info(`Player ${deviceId} disconnected`);
    });

    this.players.set(deviceId, state);
    this.addToIndexes(state);
    socket.send(
      JSON.stringify({
        schemaVersion: 1,
        type: 'player.connected',
        deviceId,
        connectedAt: state.connectedAt,
      }),
    );
    logger.info(`Player ${deviceId} connected`);
  }

  private notifyIndex(
    index: Map<string, Set<string>>,
    id: string,
    message: Omit<ManifestUpdatedMessage, 'deviceId'>,
  ): number {
    const deviceIds = index.get(id);
    if (!deviceIds) return 0;

    let delivered = 0;
    for (const deviceId of deviceIds) {
      if (this.notifyManifestUpdated({ ...message, deviceId })) {
        delivered += 1;
      }
    }
    return delivered;
  }

  private addToIndexes(state: PlayerSocketState): void {
    this.addToIndex(this.tenants, state.tenantId, state.deviceId);
    this.addToIndex(this.sites, state.siteId, state.deviceId);
    this.addToIndex(this.groups, state.groupId, state.deviceId);
  }

  private removeFromIndexes(state: PlayerSocketState): void {
    this.removeFromIndex(this.tenants, state.tenantId, state.deviceId);
    this.removeFromIndex(this.sites, state.siteId, state.deviceId);
    this.removeFromIndex(this.groups, state.groupId, state.deviceId);
  }

  private addToIndex(
    index: Map<string, Set<string>>,
    id: string | undefined,
    deviceId: string,
  ): void {
    if (!id) return;
    const deviceIds = index.get(id) || new Set<string>();
    deviceIds.add(deviceId);
    index.set(id, deviceIds);
  }

  private removeFromIndex(
    index: Map<string, Set<string>>,
    id: string | undefined,
    deviceId: string,
  ): void {
    if (!id) return;
    const deviceIds = index.get(id);
    if (!deviceIds) return;
    deviceIds.delete(deviceId);
    if (deviceIds.size === 0) {
      index.delete(id);
    }
  }

  private checkHeartbeats(): void {
    const now = Date.now();
    for (const [deviceId, state] of this.players.entries()) {
      if (now - state.lastPongAt > this.heartbeatMs * 2) {
        logger.warn(`Player ${deviceId} heartbeat timed out`);
        state.socket.terminate();
        this.players.delete(deviceId);
        continue;
      }

      if (state.socket.readyState === state.socket.OPEN) {
        state.socket.ping();
      }
    }
  }

  async close(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    for (const state of this.players.values()) {
      state.socket.close(1000, 'Gateway shutting down');
    }
    this.players.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.server) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
      this.server = null;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }
}
