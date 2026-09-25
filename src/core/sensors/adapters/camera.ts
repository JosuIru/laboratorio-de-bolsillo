import { VisionCamera } from 'react-native-vision-camera';

import { combineHardwareAndPermission, type PermissionSnapshot } from '../availabilityRules';
import type { SensorAccessController, SensorAvailability } from '../types';

type CameraPermissionStatus = 'not-determined' | 'authorized' | 'denied' | 'restricted';

function toPermissionSnapshot(cameraPermission: CameraPermissionStatus): PermissionSnapshot {
  if (cameraPermission === 'authorized') return { status: 'granted', canAskAgain: true };
  if (cameraPermission === 'not-determined') return { status: 'undetermined', canAskAgain: true };
  // «restricted» (control parental, MDM) y «denied» tras preguntar: solo desde los ajustes.
  return { status: 'denied', canAskAgain: false };
}

async function readCameraAvailability(shouldRequestPermission: boolean): Promise<SensorAvailability> {
  try {
    if (shouldRequestPermission) await VisionCamera.requestCameraPermission();
    return combineHardwareAndPermission(
      'camera',
      true,
      toPermissionSnapshot(VisionCamera.cameraPermissionStatus as CameraPermissionStatus),
    );
  } catch {
    return combineHardwareAndPermission('camera', false, null);
  }
}

export const cameraController: SensorAccessController = {
  sensorKind: 'camera',
  checkAvailability: () => readCameraAvailability(false),
  requestPermission: () => readCameraAvailability(true),
};
