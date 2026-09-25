/** Datos de fabricante de un anuncio: el company id del Bluetooth SIG y los bytes que lo siguen. */
export interface NativeManufacturerData {
  companyId: number;
  /** Bytes sin signo (0-255), sin el company id. */
  bytes: number[];
}

export interface NativeServiceData {
  /** UUID de 128 bits en mayúsculas (los de 16 bits van sobre la base del Bluetooth SIG). */
  uuid: string;
  bytes: number[];
}

/** Un anuncio BLE tal como lo entrega el escáner nativo. */
export interface NativeAdvertisement {
  address: string;
  rssi: number;
  /** Tiempo Unix en milisegundos en que el sistema recibió el anuncio. */
  timestampMilliseconds: number;
  manufacturerData: NativeManufacturerData[];
  serviceUuids: string[];
  serviceData: NativeServiceData[];
  localName: string | null;
  isConnectable: boolean;
}

export interface NativePermissionResponse {
  status: 'granted' | 'denied' | 'undetermined';
  granted: boolean;
  canAskAgain: boolean;
}

export type BleScannerEvents = {
  onAdvertisementBatch(event: { advertisements: NativeAdvertisement[] }): void;
  /** Código de ScanCallback.SCAN_FAILED_* de Android. */
  onScanError(event: { errorCode: number }): void;
};
