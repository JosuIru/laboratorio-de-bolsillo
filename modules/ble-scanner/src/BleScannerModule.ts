import { type NativeModule, requireOptionalNativeModule } from 'expo';

import type { BleScannerEvents, NativePermissionResponse } from './BleScanner.types';

declare class BleScannerNativeModule extends NativeModule<BleScannerEvents> {
  isBluetoothLowEnergyAvailable(): boolean;
  isBluetoothEnabled(): boolean;
  isScanning(): boolean;
  getPermissionsAsync(): Promise<NativePermissionResponse>;
  requestPermissionsAsync(): Promise<NativePermissionResponse>;
  /** Lanza si no hay permiso, Bluetooth o hardware. */
  startScan(): void;
  stopScan(): void;
}

/**
 * `null` en iOS, en la web, en los tests y en builds que no incluyen el módulo: quien lo use
 * debe degradar con elegancia.
 */
export const bleScannerModule = requireOptionalNativeModule<BleScannerNativeModule>('BleScanner');
