import { SchedulerDbService } from './scheduler-db.service';

const zone = { id: 'full-screen', name: 'Full Screen', x: 0, y: 0, width: 1920, height: 1080 };
const media = {
  id: 'item-1', mediaId: 'media-1', durationSec: 10, fit: null,
  position: null, zoneId: null, filename: 'video.mp4',
  cdnUrl: 'https://redsxp-assets.s3.ap-south-1.amazonaws.com/uploads/video.mp4',
  s3Key: 'uploads/video.mp4', sourceType: 'upload', externalUrl: null,
  width: null, height: null, mediaTypeName: 'video/mp4',
  sizeBytes: 123, mediaUpdatedAt: null,
};

describe('scheduler media URL', () => {
  it('uses the configured player CDN and the persisted S3 key', async () => {
    const db = new SchedulerDbService('postgresql://unused:unused@localhost/unused', 'https://d1zue4w6hf1jx0.cloudfront.net/');
    try {
      const item = db['mapPlaybackItem'](media, new Map([[zone.id, zone]]), zone);
      expect(item.url).toBe('https://d1zue4w6hf1jx0.cloudfront.net/uploads/video.mp4');
    } finally {
      await db.close();
    }
  });

  it('keeps external media URLs unchanged', async () => {
    const db = new SchedulerDbService('postgresql://unused:unused@localhost/unused', 'https://d1zue4w6hf1jx0.cloudfront.net');
    try {
      const item = db['mapPlaybackItem']({ ...media, sourceType: 'external_url', externalUrl: 'https://example.org/video.mp4' }, new Map([[zone.id, zone]]), zone);
      expect(item.url).toBe('https://example.org/video.mp4');
    } finally {
      await db.close();
    }
  });
});
