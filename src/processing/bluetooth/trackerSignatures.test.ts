import { toFullServiceUuid, toShortServiceUuid } from './advertisement';
import {
  airTagNearOwnerAdvertisement,
  airTagSeparatedAdvertisement,
  appleNearbyInfoAdvertisement,
  buildAdvertisement,
  chipoloAdvertisement,
  dultAdvertisement,
  eddystoneUrlAdvertisement,
  genericFitnessBandAdvertisement,
  googleFindHubAdvertisement,
  iBeaconAdvertisement,
  iPhoneFindMyAdvertisement,
  samsungPhoneAdvertisement,
  smartTagAdvertisement,
  tileAdvertisement,
} from './exampleAdvertisements';
import { classifyAdvertisement } from './trackerSignatures';

describe('UUID de servicio', () => {
  it('reconoce la forma corta y la de 128 bits sobre la base del Bluetooth SIG', () => {
    expect(toShortServiceUuid('0000FEED-0000-1000-8000-00805F9B34FB')).toBe(0xfeed);
    expect(toShortServiceUuid('0000feed-0000-1000-8000-00805f9b34fb')).toBe(0xfeed);
    expect(toShortServiceUuid('FE33')).toBe(0xfe33);
    expect(toShortServiceUuid('0xFCB2')).toBe(0xfcb2);
    expect(toShortServiceUuid('6E400001-B5A3-F393-E0A9-E50E24DCCA9E')).toBeNull();
    expect(toFullServiceUuid(0xfd5a)).toBe('0000FD5A-0000-1000-8000-00805F9B34FB');
  });
});

describe('clasificación de rastreadores por firma', () => {
  it('AirTag separado: Find My 0x12 con clave completa', () => {
    expect(classifyAdvertisement(airTagSeparatedAdvertisement('AA:00:00:00:00:01'))).toMatchObject({
      kind: 'apple-find-my',
      mode: 'separated',
      appleDeviceType: 'airtag',
      batteryLevel: 'full',
      isDedicatedTracker: true,
      signatureKey: 'apple-find-my:airtag',
    });
  });

  it('AirTag cerca de su dueño: mensaje corto y batería media', () => {
    expect(classifyAdvertisement(airTagNearOwnerAdvertisement('AA:00:00:00:00:02'))).toMatchObject({
      kind: 'apple-find-my',
      mode: 'near-owner',
      appleDeviceType: 'airtag',
      batteryLevel: 'medium',
    });
  });

  it('distingue accesorios Find My de terceros, AirPods y dispositivos Apple por los bits 4-5 del estado', () => {
    const withStatusByte = (statusByte: number) =>
      classifyAdvertisement(
        buildAdvertisement({ address: 'x', manufacturerData: [{ companyId: 0x004c, bytes: [0x12, 0x02, statusByte, 0x00] }] }),
      );
    expect(withStatusByte(0x20)).toMatchObject({ appleDeviceType: 'find-my-accessory', isDedicatedTracker: true });
    expect(withStatusByte(0x30)).toMatchObject({ appleDeviceType: 'airpods', isDedicatedTracker: false });
    expect(withStatusByte(0xd0)).toMatchObject({ appleDeviceType: 'airtag', batteryLevel: 'critical' });
    expect(classifyAdvertisement(iPhoneFindMyAdvertisement('x'))).toMatchObject({
      appleDeviceType: 'apple-device',
      isDedicatedTracker: false,
    });
  });

  it('no confunde otros anuncios de Apple (iBeacon, Nearby Info) con rastreadores', () => {
    expect(classifyAdvertisement(iBeaconAdvertisement('x'))).toBeNull();
    expect(classifyAdvertisement(appleNearbyInfoAdvertisement('x'))).toBeNull();
  });

  it('Samsung: el servicio 0xFD5A es búsqueda sin conexión; 0x0075 solo, un aparato Samsung corriente', () => {
    expect(classifyAdvertisement(smartTagAdvertisement('x'))).toMatchObject({ kind: 'samsung-find', isDedicatedTracker: true });
    expect(classifyAdvertisement(samsungPhoneAdvertisement('x'))).toMatchObject({
      kind: 'samsung-device',
      isDedicatedTracker: false,
    });
  });

  it('Tile (0xFEED o 0xFEEC) y Chipolo (0xFE33)', () => {
    expect(classifyAdvertisement(tileAdvertisement('x'))).toMatchObject({ kind: 'tile', mode: 'unknown' });
    expect(classifyAdvertisement(buildAdvertisement({ address: 'x', serviceUuids: ['FEEC'] }))).toMatchObject({ kind: 'tile' });
    expect(classifyAdvertisement(chipoloAdvertisement('x'))).toMatchObject({ kind: 'chipolo', isDedicatedTracker: true });
  });

  it('Google Find Hub: trama Eddystone 0x40, y 0x41 en modo contra rastreo no deseado', () => {
    expect(classifyAdvertisement(googleFindHubAdvertisement('x', false))).toMatchObject({
      kind: 'google-find-hub',
      mode: 'unknown',
    });
    expect(classifyAdvertisement(googleFindHubAdvertisement('x', true))).toMatchObject({
      kind: 'google-find-hub',
      mode: 'separated',
    });
    expect(classifyAdvertisement(eddystoneUrlAdvertisement('x'))).toBeNull();
  });

  it('DULT: accesorio de marca desconocida separado; con marca conocida solo marca el modo', () => {
    expect(classifyAdvertisement(dultAdvertisement('x'))).toMatchObject({
      kind: 'dult',
      mode: 'separated',
      announcesDult: true,
    });
    const chipoloWithDult = buildAdvertisement({
      address: 'x',
      serviceUuids: [toFullServiceUuid(0xfe33)],
      serviceData: [{ uuid: toFullServiceUuid(0xfcb2), bytes: [0x01] }],
    });
    expect(classifyAdvertisement(chipoloWithDult)).toMatchObject({ kind: 'chipolo', mode: 'separated', announcesDult: true });
  });

  it('ignora lo que no es un rastreador', () => {
    expect(classifyAdvertisement(genericFitnessBandAdvertisement('x'))).toBeNull();
    expect(classifyAdvertisement(buildAdvertisement({ address: 'x' }))).toBeNull();
  });
});
