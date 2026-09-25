import { AudioManager } from 'react-native-audio-api';

import { combineHardwareAndPermission, type PermissionSnapshot } from '../availabilityRules';
import type { SensorAccessController, SensorAvailability } from '../types';

type RecordingPermissionStatus = 'Undetermined' | 'Denied' | 'Granted';

/**
 * Android no dice si el usuario ha marcado «no volver a preguntar». Tras una petición
 * denegada, el sistema ya no suele mostrar el diálogo, así que se ofrece ir a los ajustes.
 */
let wasRequestDeniedThisSession = false;

function toPermissionSnapshot(recordingPermission: RecordingPermissionStatus): PermissionSnapshot {
  if (recordingPermission === 'Granted') return { status: 'granted', canAskAgain: true };
  if (recordingPermission === 'Denied') return { status: 'denied', canAskAgain: !wasRequestDeniedThisSession };
  return { status: 'undetermined', canAskAgain: true };
}

async function readMicrophoneAvailability(shouldRequestPermission: boolean): Promise<SensorAvailability> {
  try {
    const recordingPermission = shouldRequestPermission
      ? await AudioManager.requestRecordingPermissions()
      : await AudioManager.checkRecordingPermissions();
    if (shouldRequestPermission && recordingPermission === 'Denied') wasRequestDeniedThisSession = true;
    // Todos los móviles tienen micrófono: si la consulta funciona, el hardware está.
    return combineHardwareAndPermission('microphone', true, toPermissionSnapshot(recordingPermission));
  } catch {
    return combineHardwareAndPermission('microphone', false, null);
  }
}

export const microphoneController: SensorAccessController = {
  sensorKind: 'microphone',
  checkAvailability: () => readMicrophoneAvailability(false),
  requestPermission: () => readMicrophoneAvailability(true),
};
