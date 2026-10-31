import { SchedulerService } from './scheduler.service';

describe('scheduler playlist manifest versions', () => {
  const previousV4 = process.env.SENSOR_MANIFEST_V4_ENABLED;
  const previousV5 = process.env.SENSOR_MANIFEST_V5_ENABLED;
  afterEach(() => {
    if (previousV4 === undefined) delete process.env.SENSOR_MANIFEST_V4_ENABLED;
    else process.env.SENSOR_MANIFEST_V4_ENABLED = previousV4;
    if (previousV5 === undefined) delete process.env.SENSOR_MANIFEST_V5_ENABLED;
    else process.env.SENSOR_MANIFEST_V5_ENABLED = previousV5;
  });

  function fixture(sensorTriggers: unknown[]) {
    const db = {
      getPublishedSchedules: jest.fn().mockResolvedValue([{ id: 'schedule-1', name: 'Test', playlistId: 'playlist-1', priority: 1,
        startAt: new Date(Date.now() - 60000), endAt: new Date(Date.now() + 60000), daysOfWeek: [new Date().getDay()] }]),
      getPlaylistPlaybackManifest: jest.fn().mockResolvedValue({ playlistId: 'playlist-1', canvas: { width: 1920, height: 1080 }, zones: [], items: [], sensorTriggers }),
    };
    const publisher = { publishPlaylist: jest.fn().mockResolvedValue('https://example.test/playlist'), publish: jest.fn().mockResolvedValue('https://example.test/device') };
    const redis = { getManifestState: jest.fn().mockResolvedValue(null), setManifestState: jest.fn().mockResolvedValue(undefined) };
    const events = { emitManifestPublished: jest.fn().mockResolvedValue(undefined) };
    const gateway = { supportsSensorTriggers: jest.fn().mockReturnValue(true), notifyManifestUpdated: jest.fn() };
    const service = new SchedulerService(db as any, {} as any, publisher as any, redis as any, events as any, gateway as any);
    return { service: service as any, publisher, gateway, db };
  }

  const gpio = { transport: 'gpio', port: '17', value: true };
  const message = { transport: 'serial-message', serialPort: 'COM4', matchMode: 'exact', matchValue: 'XR[PU001]' };

  it.each([
    [[], 3, undefined],
    [[gpio], 4, 4],
    [[gpio, message], 5, 5],
  ])('publishes %j triggers as schema %i', async (triggers, version, capability) => {
    process.env.SENSOR_MANIFEST_V4_ENABLED = 'true';
    process.env.SENSOR_MANIFEST_V5_ENABLED = 'true';
    const { service, publisher, gateway } = fixture(triggers as unknown[]);
    await service.publishScheduleManifestForDevice('device-1', 'realtime_job');
    expect(publisher.publishPlaylist).toHaveBeenCalledWith(expect.objectContaining({ schemaVersion: version }));
    if (capability) expect(gateway.supportsSensorTriggers).toHaveBeenCalledWith('device-1', capability);
    else expect(gateway.supportsSensorTriggers).not.toHaveBeenCalled();
  });

  it('does not publish a message manifest when the v5 flag or player capability is absent', async () => {
    delete process.env.SENSOR_MANIFEST_V5_ENABLED;
    const { service, publisher, gateway } = fixture([message]);
    await expect(service.publishScheduleManifestForDevice('device-1', 'realtime_job')).rejects.toThrow('SENSOR_MANIFEST_V5_ENABLED');
    expect(publisher.publishPlaylist).not.toHaveBeenCalled();

    process.env.SENSOR_MANIFEST_V5_ENABLED = 'true';
    gateway.supportsSensorTriggers.mockReturnValue(false);
    await expect(service.publishScheduleManifestForDevice('device-1', 'realtime_job')).rejects.toThrow('playlist-v5');
    expect(publisher.publishPlaylist).not.toHaveBeenCalled();
  });

  it('changes the manifest version hash when the matched message changes', async () => {
    process.env.SENSOR_MANIFEST_V5_ENABLED = 'true';
    const { service, publisher, db } = fixture([message]);
    await service.publishScheduleManifestForDevice('device-1', 'realtime_job');
    const firstVersion = publisher.publishPlaylist.mock.calls[0][0].playlistVersion;
    db.getPlaylistPlaybackManifest.mockResolvedValue({ playlistId: 'playlist-1', canvas: { width: 1920, height: 1080 }, zones: [], items: [],
      sensorTriggers: [{ ...message, matchValue: 'XR[PU002]' }] });
    await service.publishScheduleManifestForDevice('device-1', 'realtime_job');
    expect(publisher.publishPlaylist.mock.calls[1][0].playlistVersion).not.toBe(firstVersion);
  });
});
