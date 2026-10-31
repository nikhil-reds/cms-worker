import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { PlayerWebSocketGatewayService } from './player-websocket-gateway.service';

describe('player sensor capabilities', () => {
  it('requires an advertised schema and supported adapter for each sensor manifest version', () => {
    const gateway = new PlayerWebSocketGatewayService(3031, '/ws/player', 30000, false, async () => null);
    const wire = Object.assign(new EventEmitter(), { readyState: 1, OPEN: 1, send: jest.fn() });
    gateway['registerPlayer']({ deviceId: 'screen-1' }, wire as unknown as WebSocket);

    expect(gateway.supportsSensorTriggers('screen-1', 4)).toBe(false);
    expect(gateway.supportsSensorTriggers('screen-1', 5)).toBe(false);

    wire.emit('message', Buffer.from(JSON.stringify({ type: 'player.capabilities', playlistSchemas: [3, 4], sensorAdapter: 'nexmosphere' })));
    expect(gateway.supportsSensorTriggers('screen-1', 4)).toBe(true);
    expect(gateway.supportsSensorTriggers('screen-1', 5)).toBe(false);

    wire.emit('message', Buffer.from(JSON.stringify({ type: 'player.capabilities', playlistSchemas: [3, 4, 5], sensorAdapter: 'nexmosphere' })));
    expect(gateway.supportsSensorTriggers('screen-1', 5)).toBe(true);

    wire.emit('message', Buffer.from(JSON.stringify({ type: 'player.capabilities', playlistSchemas: [3, 4, 5], sensorAdapter: 'off' })));
    expect(gateway.supportsSensorTriggers('screen-1', 5)).toBe(false);
  });
});
