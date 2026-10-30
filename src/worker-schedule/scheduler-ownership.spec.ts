import { SchedulerService } from './scheduler.service';

describe('scheduler device ownership', () => {
  const previous = process.env.SCHEDULER_DEVICE_IDS;
  afterEach(() => {
    if (previous === undefined) delete process.env.SCHEDULER_DEVICE_IDS;
    else process.env.SCHEDULER_DEVICE_IDS = previous;
  });
  function fixture() {
    const db = {
      getTargetDevices: jest.fn().mockResolvedValue([
        { id: 'screen-1', tenantId: 'tenant-1', name: 'One' },
        { id: 'screen-2', tenantId: 'tenant-1', name: 'Two' },
      ]),
      getUntargetedActiveCalendars: jest.fn().mockResolvedValue([]),
      getPublishedSchedules: jest.fn().mockResolvedValue([{ playlistId: 'playlist-1' }]),
    };
    const service = new SchedulerService(db as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    const publish = jest.spyOn(service as any, 'publishScheduleManifestForDevice').mockResolvedValue({
      changed: true, activePlaylistId: 'playlist-1', activeScheduleId: 'schedule-1',
    });
    return { service: service as any, publish };
  }
  it.each(['backup_tick', 'realtime_job'])('limits %s to owned screens', async source => {
    process.env.SCHEDULER_DEVICE_IDS = ' screen-1 ';
    const { service, publish } = fixture();
    await service.publishScheduleManifest(source, source === 'realtime_job' ? { tenantId: 'tenant-1', playlistId: 'playlist-1' } : undefined);
    expect(publish.mock.calls).toEqual([['screen-1', source]]);
  });
  it('retains existing all-device behavior when ownership is unset', async () => {
    delete process.env.SCHEDULER_DEVICE_IDS;
    const { service, publish } = fixture();
    await service.publishScheduleManifest('backup_tick');
    expect(publish).toHaveBeenCalledTimes(2);
  });
  it('an explicitly empty ownership list never falls back to all screens', async () => {
    process.env.SCHEDULER_DEVICE_IDS = ' , ';
    const { service, publish } = fixture();
    await service.publishScheduleManifest('backup_tick');
    expect(publish).not.toHaveBeenCalled();
  });
  it('ownership cannot bypass the sensor job tenant scope', async () => {
    process.env.SCHEDULER_DEVICE_IDS = 'screen-1';
    const { service, publish } = fixture();
    await service.publishScheduleManifest('realtime_job', { tenantId: 'other', playlistId: 'playlist-1' });
    expect(publish).not.toHaveBeenCalled();
  });
});
