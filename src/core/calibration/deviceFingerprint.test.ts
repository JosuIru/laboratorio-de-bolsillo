import { buildDeviceFingerprint } from './deviceFingerprint';

describe('buildDeviceFingerprint', () => {
  it('normaliza fabricante y modelo', () => {
    expect(buildDeviceFingerprint('Google', 'Pixel 8 Pro')).toBe('google:pixel-8-pro');
    expect(buildDeviceFingerprint('  Xiaomi ', 'Redmi Note 13 (5G)')).toBe('xiaomi:redmi-note-13-5g');
  });

  it('usa "unknown" cuando falta información', () => {
    expect(buildDeviceFingerprint(null, undefined)).toBe('unknown:unknown');
    expect(buildDeviceFingerprint('***', 'A1')).toBe('unknown:a1');
  });
});
