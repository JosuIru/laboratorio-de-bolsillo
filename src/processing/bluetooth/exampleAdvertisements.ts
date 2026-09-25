import { type BleAdvertisement, toFullServiceUuid } from './advertisement';

/**
 * Anuncios de ejemplo con la forma que tienen los reales (bytes tras el company id, como los
 * entrega Android). Los bytes de clave son de relleno: el análisis no los usa.
 */
const fillerKeyBytes = Array.from({ length: 22 }, (_, byteIndex) => (byteIndex * 37 + 11) & 0xff);

export function buildAdvertisement(overrides: Partial<BleAdvertisement> & { address: string }): BleAdvertisement {
  return {
    rssi: -60,
    timestampMilliseconds: 0,
    manufacturerData: [],
    serviceUuids: [],
    serviceData: [],
    localName: null,
    ...overrides,
  };
}

/** AirTag separado de su dueño: tipo 0x12, longitud 0x19, estado 0x10 (AirTag, batería llena). */
export function airTagSeparatedAdvertisement(address: string, rssi = -60, timestampMilliseconds = 0): BleAdvertisement {
  return buildAdvertisement({
    address,
    rssi,
    timestampMilliseconds,
    manufacturerData: [{ companyId: 0x004c, bytes: [0x12, 0x19, 0x10, ...fillerKeyBytes, 0x01, 0x00] }],
  });
}

/** AirTag cerca de su dueño: mensaje corto (longitud 0x02), estado 0x50 (AirTag, batería media). */
export function airTagNearOwnerAdvertisement(address: string, rssi = -60, timestampMilliseconds = 0): BleAdvertisement {
  return buildAdvertisement({
    address,
    rssi,
    timestampMilliseconds,
    manufacturerData: [{ companyId: 0x004c, bytes: [0x12, 0x02, 0x50, 0x02] }],
  });
}

/** Un iPhone en la red Find My (estado 0x00: dispositivo Apple). */
export function iPhoneFindMyAdvertisement(address: string): BleAdvertisement {
  return buildAdvertisement({
    address,
    manufacturerData: [{ companyId: 0x004c, bytes: [0x12, 0x02, 0x00, 0x03] }],
  });
}

/** iBeacon de Apple (tipo 0x02, longitud 0x15): no es un rastreador. */
export function iBeaconAdvertisement(address: string): BleAdvertisement {
  return buildAdvertisement({
    address,
    manufacturerData: [{ companyId: 0x004c, bytes: [0x02, 0x15, ...fillerKeyBytes.slice(0, 16), 0x00, 0x01, 0x00, 0x02, 0xc5] }],
  });
}

/** Apple «Nearby Info» (tipo 0x10) que emiten iPhones y Macs a todas horas: no es un rastreador. */
export function appleNearbyInfoAdvertisement(address: string): BleAdvertisement {
  return buildAdvertisement({
    address,
    manufacturerData: [{ companyId: 0x004c, bytes: [0x10, 0x05, 0x01, 0x18, 0x44, 0x2a, 0x9b] }],
  });
}

export function smartTagAdvertisement(address: string, rssi = -60, timestampMilliseconds = 0): BleAdvertisement {
  return buildAdvertisement({
    address,
    rssi,
    timestampMilliseconds,
    serviceData: [{ uuid: toFullServiceUuid(0xfd5a), bytes: [0x42, ...fillerKeyBytes.slice(0, 18)] }],
  });
}

/** Un móvil Samsung cualquiera: datos de fabricante 0x0075 sin el servicio de búsqueda. */
export function samsungPhoneAdvertisement(address: string): BleAdvertisement {
  return buildAdvertisement({
    address,
    manufacturerData: [{ companyId: 0x0075, bytes: [0x42, 0x04, 0x01, 0x80, 0x66] }],
  });
}

export function tileAdvertisement(address: string, rssi = -60, timestampMilliseconds = 0): BleAdvertisement {
  return buildAdvertisement({
    address,
    rssi,
    timestampMilliseconds,
    serviceUuids: [toFullServiceUuid(0xfeed)],
    serviceData: [{ uuid: toFullServiceUuid(0xfeed), bytes: [0x02, 0x00, 0x7a, 0x1c, 0x33, 0x90, 0x11, 0x5e] }],
  });
}

export function chipoloAdvertisement(address: string): BleAdvertisement {
  return buildAdvertisement({ address, serviceUuids: [toFullServiceUuid(0xfe33)] });
}

export function dultAdvertisement(address: string): BleAdvertisement {
  return buildAdvertisement({
    address,
    serviceData: [{ uuid: toFullServiceUuid(0xfcb2), bytes: [0x01, ...fillerKeyBytes.slice(0, 10)] }],
  });
}

export function googleFindHubAdvertisement(address: string, isUnwantedTrackingMode: boolean): BleAdvertisement {
  return buildAdvertisement({
    address,
    serviceData: [
      { uuid: toFullServiceUuid(0xfeaa), bytes: [isUnwantedTrackingMode ? 0x41 : 0x40, ...fillerKeyBytes.slice(0, 20)] },
    ],
  });
}

/** Eddystone-URL corriente: no es un rastreador. */
export function eddystoneUrlAdvertisement(address: string): BleAdvertisement {
  return buildAdvertisement({
    address,
    serviceData: [{ uuid: toFullServiceUuid(0xfeaa), bytes: [0x10, 0xeb, 0x03, 0x67, 0x6f, 0x6f] }],
  });
}

/** Una pulsera de actividad genérica: ni fabricante ni servicio conocido. */
export function genericFitnessBandAdvertisement(address: string): BleAdvertisement {
  return buildAdvertisement({ address, serviceUuids: [toFullServiceUuid(0x180d)], localName: 'Band 7' });
}
