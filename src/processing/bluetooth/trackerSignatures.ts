import { advertisesService, type BleAdvertisement, findManufacturerBytes, findServiceDataBytes } from './advertisement';

/**
 * Firmas de rastreadores. Las constantes son identificadores públicos asignados por el
 * Bluetooth SIG; la interpretación de los bytes de Apple y Google sigue la ingeniería inversa
 * publicada (SEEMOO/AirGuard, «Find You», el borrador DULT de la IETF).
 */
export const appleCompanyId = 0x004c;
export const samsungCompanyId = 0x0075;
/** Tipo de mensaje de Apple «Offline Finding» (red Find My / Encontrar). */
export const appleFindMyMessageType = 0x12;
/** Longitud del mensaje Find My con la clave pública completa: el accesorio está separado de su dueño. */
export const appleFindMySeparatedPayloadLength = 0x19;
/** Longitud del mensaje Find My corto: el accesorio está cerca de su dueño. */
export const appleFindMyNearOwnerPayloadLength = 0x02;
/** Servicio de búsqueda sin conexión de Samsung (SmartTag y dispositivos Galaxy). */
export const samsungOfflineFindingServiceUuid = 0xfd5a;
/** Servicios asignados a Tile, Inc. */
export const tileServiceUuids: readonly number[] = [0xfeed, 0xfeec];
/** Servicio asignado a CHIPOLO d.o.o. */
export const chipoloServiceUuid = 0xfe33;
/** Servicio del estándar DULT (Detecting Unwanted Location Trackers) de Apple y Google. */
export const dultServiceUuid = 0xfcb2;
/** Eddystone: la red Encontrar de Google (Find Hub) usa sus tramas 0x40 y 0x41. */
export const eddystoneServiceUuid = 0xfeaa;
export const googleFindHubFrameType = 0x40;
/** Trama de Find Hub en modo de protección contra rastreo no deseado (separado del dueño). */
export const googleFindHubUnwantedTrackingFrameType = 0x41;

export type TrackerKind =
  | 'apple-find-my'
  | 'samsung-find'
  | 'tile'
  | 'chipolo'
  | 'google-find-hub'
  | 'dult'
  /** Dispositivo Samsung que no anuncia búsqueda sin conexión: casi siempre un móvil, reloj o auriculares. */
  | 'samsung-device';

/** Qué tipo de aparato Find My dice ser (bits 4-5 del byte de estado). */
export type AppleFindMyDeviceType = 'apple-device' | 'airtag' | 'find-my-accessory' | 'airpods';

export type TrackerMode =
  /** Lejos de su dueño desde hace un rato: el caso que importa para el rastreo no deseado. */
  | 'separated'
  /** Cerca del móvil de su dueño. */
  | 'near-owner'
  /** La firma no dice en qué modo está. */
  | 'unknown';

export type BatteryLevel = 'full' | 'medium' | 'low' | 'critical';

export interface TrackerClassification {
  kind: TrackerKind;
  mode: TrackerMode;
  /** Solo para Find My. */
  appleDeviceType?: AppleFindMyDeviceType;
  /** Solo para Find My: nivel de batería que anuncia el propio rastreador. */
  batteryLevel?: BatteryLevel;
  /**
   * `true` para aparatos pensados para rastrear (AirTag, SmartTag, Tile…). Un iPhone o unos
   * AirPods también están en la red Find My, pero no se tratan como rastreadores ocultos.
   */
  isDedicatedTracker: boolean;
  /** Además anuncia el servicio DULT (los rastreadores compatibles lo hacen al estar separados). */
  announcesDult: boolean;
  /** Clave de firma para agrupar direcciones rotativas: no cambia al cambiar la dirección. */
  signatureKey: string;
}

const appleDeviceTypeByBits: readonly AppleFindMyDeviceType[] = ['apple-device', 'airtag', 'find-my-accessory', 'airpods'];
const batteryLevelByBits: readonly BatteryLevel[] = ['full', 'medium', 'low', 'critical'];

function classifyAppleFindMy(appleBytes: readonly number[]): Omit<TrackerClassification, 'announcesDult' | 'signatureKey'> | null {
  if (appleBytes[0] !== appleFindMyMessageType) return null;
  const payloadLength = appleBytes[1];
  const mode: TrackerMode =
    payloadLength !== undefined && payloadLength >= appleFindMySeparatedPayloadLength
      ? 'separated'
      : payloadLength === appleFindMyNearOwnerPayloadLength
        ? 'near-owner'
        : 'unknown';
  const statusByte = appleBytes[2];
  if (statusByte === undefined) return { kind: 'apple-find-my', mode, isDedicatedTracker: true };
  const appleDeviceType = appleDeviceTypeByBits[(statusByte >> 4) & 0b11] ?? 'apple-device';
  const batteryLevel = batteryLevelByBits[(statusByte >> 6) & 0b11] ?? 'full';
  return {
    kind: 'apple-find-my',
    mode,
    appleDeviceType,
    batteryLevel,
    isDedicatedTracker: appleDeviceType === 'airtag' || appleDeviceType === 'find-my-accessory',
  };
}

function classifyByBrand(
  advertisement: BleAdvertisement,
): Omit<TrackerClassification, 'announcesDult' | 'signatureKey'> | null {
  const appleBytes = findManufacturerBytes(advertisement, appleCompanyId);
  if (appleBytes) {
    const appleClassification = classifyAppleFindMy(appleBytes);
    if (appleClassification) return appleClassification;
  }
  if (advertisesService(advertisement, samsungOfflineFindingServiceUuid)) {
    return { kind: 'samsung-find', mode: 'unknown', isDedicatedTracker: true };
  }
  if (tileServiceUuids.some((tileServiceUuid) => advertisesService(advertisement, tileServiceUuid))) {
    return { kind: 'tile', mode: 'unknown', isDedicatedTracker: true };
  }
  if (advertisesService(advertisement, chipoloServiceUuid)) {
    return { kind: 'chipolo', mode: 'unknown', isDedicatedTracker: true };
  }
  const eddystoneBytes = findServiceDataBytes(advertisement, eddystoneServiceUuid);
  const eddystoneFrameType = eddystoneBytes?.[0];
  if (eddystoneFrameType === googleFindHubFrameType || eddystoneFrameType === googleFindHubUnwantedTrackingFrameType) {
    return {
      kind: 'google-find-hub',
      mode: eddystoneFrameType === googleFindHubUnwantedTrackingFrameType ? 'separated' : 'unknown',
      isDedicatedTracker: true,
    };
  }
  if (advertisesService(advertisement, dultServiceUuid)) {
    // Un accesorio DULT de marca desconocida: la especificación lo anuncia estando separado.
    return { kind: 'dult', mode: 'separated', isDedicatedTracker: true };
  }
  if (findManufacturerBytes(advertisement, samsungCompanyId)) {
    return { kind: 'samsung-device', mode: 'unknown', isDedicatedTracker: false };
  }
  return null;
}

/**
 * Clasifica un anuncio por su firma. Devuelve `null` si no se parece a ningún rastreador ni a
 * un dispositivo de las redes de búsqueda conocidas.
 */
export function classifyAdvertisement(advertisement: BleAdvertisement): TrackerClassification | null {
  const brandClassification = classifyByBrand(advertisement);
  if (!brandClassification) return null;
  const announcesDult = advertisesService(advertisement, dultServiceUuid);
  // El anuncio DULT solo se emite con el accesorio separado de su dueño.
  const mode = announcesDult && brandClassification.mode === 'unknown' ? 'separated' : brandClassification.mode;
  const signatureKey = [brandClassification.kind, brandClassification.appleDeviceType].filter(Boolean).join(':');
  return { ...brandClassification, mode, announcesDult, signatureKey };
}
