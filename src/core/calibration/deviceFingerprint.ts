import * as Device from 'expo-device';

/** Pasa a minúsculas y deja solo letras, números y guiones: estable entre versiones de sistema. */
export function buildDeviceFingerprint(
  manufacturer: string | null | undefined,
  modelName: string | null | undefined,
): string {
  const normalizePart = (rawPart: string | null | undefined) =>
    (rawPart ?? 'unknown')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unknown';
  return `${normalizePart(manufacturer)}:${normalizePart(modelName)}`;
}

let cachedDeviceFingerprint: string | null = null;

export function getDeviceFingerprint(): string {
  cachedDeviceFingerprint ??= buildDeviceFingerprint(Device.manufacturer, Device.modelName);
  return cachedDeviceFingerprint;
}
