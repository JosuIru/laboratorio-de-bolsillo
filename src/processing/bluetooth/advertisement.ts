/** Anuncio BLE ya recibido: la forma mínima que necesita el análisis (sin React ni RN). */
export interface BleAdvertisement {
  address: string;
  rssi: number;
  /** Tiempo Unix en milisegundos. */
  timestampMilliseconds: number;
  /** Company id del Bluetooth SIG + bytes que lo siguen (sin el company id). */
  manufacturerData: readonly { companyId: number; bytes: readonly number[] }[];
  /** UUID de servicio anunciados, en cualquier formato (16 o 128 bits). */
  serviceUuids: readonly string[];
  serviceData: readonly { uuid: string; bytes: readonly number[] }[];
  localName?: string | null;
}

const bluetoothBaseUuidSuffix = '-0000-1000-8000-00805F9B34FB';

/**
 * Pasa un UUID a su forma corta de 16 bits (p. ej. 0xFEED) si está sobre la base del Bluetooth
 * SIG. Devuelve `null` para UUID propietarios de 128 bits.
 */
export function toShortServiceUuid(uuid: string): number | null {
  const normalizedUuid = uuid.trim().toUpperCase();
  if (/^(0X)?[0-9A-F]{4}$/.test(normalizedUuid)) return parseInt(normalizedUuid.replace('0X', ''), 16);
  if (normalizedUuid.length === 36 && normalizedUuid.startsWith('0000') && normalizedUuid.endsWith(bluetoothBaseUuidSuffix)) {
    return parseInt(normalizedUuid.slice(4, 8), 16);
  }
  return null;
}

/** Formatea un UUID de 16 bits con la base del Bluetooth SIG, en mayúsculas. */
export function toFullServiceUuid(shortUuid: number): string {
  return `0000${shortUuid.toString(16).toUpperCase().padStart(4, '0')}${bluetoothBaseUuidSuffix}`;
}

export function findManufacturerBytes(advertisement: BleAdvertisement, companyId: number): readonly number[] | null {
  return advertisement.manufacturerData.find((manufacturerEntry) => manufacturerEntry.companyId === companyId)?.bytes ?? null;
}

export function findServiceDataBytes(advertisement: BleAdvertisement, shortUuid: number): readonly number[] | null {
  return (
    advertisement.serviceData.find((serviceEntry) => toShortServiceUuid(serviceEntry.uuid) === shortUuid)?.bytes ?? null
  );
}

/** ¿Anuncia este servicio, en la lista de UUID o con datos de servicio? */
export function advertisesService(advertisement: BleAdvertisement, shortUuid: number): boolean {
  return (
    advertisement.serviceUuids.some((serviceUuid) => toShortServiceUuid(serviceUuid) === shortUuid) ||
    findServiceDataBytes(advertisement, shortUuid) !== null
  );
}
