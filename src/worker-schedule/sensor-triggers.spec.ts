import { mapSensorTriggers, type SensorFlowRow } from './sensor-triggers';
import type { PlaylistPlaybackItem } from './scheduler-db.service';

const item: PlaylistPlaybackItem = {
  id: 'item-1', type: 'video', src: 'media/videos/door.mp4', url: 'https://example.test/door.mp4',
};
const row: SensorFlowRow = {
  id: 'edge-1', playlistId: 'playlist-1', edgePlaylistId: 'playlist-1', sourceNodeId: 'sensor-1',
  targetNodeId: 'media-node-1', sensorId: 'sensor-1', sensorPlaylistId: 'playlist-1',
  sensorKind: 'SENSOR', connectionType: 'gpio', port: '17', operator: 'equals',
  sensorName: 'Door sensor', x: 80, y: 100,
  expectedValue: true, sensorEnabled: true, targetPlaylistId: 'playlist-1',
  targetKind: 'MEDIA', targetPlaylistItemId: 'item-1', itemPlaylistId: 'playlist-1',
  cooldownMs: 2000, debounceMs: 100, edgeEnabled: true,
};

describe('mapSensorTriggers', () => {
  it('maps the CMS flow to a stable player rule', () => {
    expect(mapSensorTriggers('playlist-1', [row], [item])).toEqual([{
      id: 'edge-1', sensorId: 'sensor-1', transport: 'gpio', port: '17',
      name: 'Door sensor', x: 80, y: 100,
      operator: 'equals', value: true, targetPlaylistItemId: 'item-1',
      cooldownMs: 2000, debounceMs: 100, enabled: true,
      sensorEnabled: true, connectionEnabled: true,
    }]);
  });

  it.each([
    [{ targetPlaylistId: 'playlist-2' }, 'cross-playlist'],
    [{ id: null }, 'missing'],
    [{ expectedValue: 'true' }, 'unsupported GPIO'],
    [{ targetPlaylistItemId: 'missing' }, 'not READY'],
  ] as const)('rejects invalid flow %j', (change, reason) => {
    expect(() => mapSensorTriggers('playlist-1', [{ ...row, ...change }], [item]))
      .toThrow(reason);
  });

  it('rejects an unplayable target and duplicate targets for one sensor', () => {
    expect(() => mapSensorTriggers('playlist-1', [row], [{ ...item, type: 'image' }]))
      .toThrow('not READY');
    expect(() => mapSensorTriggers('playlist-1', [row, { ...row, id: 'edge-2' }], [item]))
      .toThrow('multiple targets');
  });
});
