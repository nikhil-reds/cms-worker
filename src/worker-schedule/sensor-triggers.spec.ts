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

  const messageRow: SensorFlowRow = {
    ...row, id: 'edge-rfid', sensorId: 'sensor-rfid', sourceNodeId: 'sensor-rfid',
    sensorName: 'RFID tag 001', serialPort: 'COM4', port: null,
    expectedValue: null, matchMode: 'exact', matchValue: 'XR[PU001]',
  };

  it('maps a complete controller message without changing a legacy button rule', () => {
    const triggers = mapSensorTriggers('playlist-1', [row, messageRow], [item]);
    expect(triggers).toEqual(expect.arrayContaining([
      expect.objectContaining({ transport: 'gpio', port: '17', value: true }),
      expect.objectContaining({ transport: 'serial-message', serialPort: 'COM4', matchMode: 'exact', matchValue: 'XR[PU001]', targetPlaylistItemId: 'item-1' }),
    ]));
    expect(triggers).toHaveLength(2);
  });

  it.each([
    [{ matchMode: null }, 'unsupported serial message'],
    [{ matchValue: 'XR[PU001]\n' }, 'unsupported serial message'],
    [{ matchValue: ' XR[PU001]' }, 'unsupported serial message'],
    [{ serialPort: null }, 'unsupported serial message'],
    [{ port: '17' }, 'unsupported serial message'],
  ] as const)('rejects invalid message rule %j', (change, reason) => {
    expect(() => mapSensorTriggers('playlist-1', [{ ...messageRow, ...change }], [item]))
      .toThrow(reason);
  });

  it('rejects duplicate messages on the same controller but accepts different tags', () => {
    const duplicate = { ...messageRow, id: 'edge-rfid-2', sensorId: 'sensor-rfid-2', sourceNodeId: 'sensor-rfid-2' };
    expect(() => mapSensorTriggers('playlist-1', [messageRow, duplicate], [item]))
      .toThrow('duplicate sensor condition');
    expect(mapSensorTriggers('playlist-1', [messageRow, { ...duplicate, matchValue: 'XR[PU002]' }], [item]))
      .toHaveLength(2);
  });

  it('rejects two active controller ports in one playlist', () => {
    expect(() => mapSensorTriggers('playlist-1', [{ ...row, serialPort: 'COM3' }, messageRow], [item]))
      .toThrow('one controller serial port');
  });
});
