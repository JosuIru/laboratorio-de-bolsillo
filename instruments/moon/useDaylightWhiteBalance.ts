/**
 * Balance de blancos fijo a luz de día (5500 K): la Luna refleja la luz del Sol, y el balance
 * automático, engañado por el cielo negro y la farola de turno, cambia de una foto a otra.
 *
 * Solo si la cámara lo admite (`supportsWhiteBalanceLocking`). En Android (parche propio de
 * VisionCamera) no se pueden fijar ganancias a mano, pero sí congelar el balance automático actual
 * (CONTROL_AWB_LOCK): toda la ráfaga sale con el mismo color y el tono se corrige al procesar.
 * `resetFocus` (al soltar el enfoque) lo quita: hay que volver a aplicarlo.
 */
import { type RefObject, useCallback, useState } from 'react';
import type { CameraDevice, CameraRef } from 'react-native-vision-camera';

const daylightTemperatureKelvin = 5500;

export type WhiteBalanceStatus = 'unsupported' | 'pending' | 'lockedDaylight' | 'lockedCurrent' | 'failed';

export function useDaylightWhiteBalance(cameraRef: RefObject<CameraRef | null>, cameraDevice: CameraDevice | undefined) {
  const isSupported = Boolean(cameraDevice?.supportsWhiteBalanceLocking);
  const [whiteBalanceStatus, setWhiteBalanceStatus] = useState<WhiteBalanceStatus>('pending');

  const applyDaylightWhiteBalance = useCallback(async () => {
    const cameraController = cameraRef.current?.controller;
    if (!isSupported || !cameraController || !cameraDevice) return false;
    try {
      const daylightGains = cameraController.convertWhiteBalanceTemperatureAndTintValues({ temperature: daylightTemperatureKelvin, tint: 0 });
      const maximumGain = Math.max(1, cameraDevice.maxWhiteBalanceGain);
      const clampGain = (gain: number) => Math.min(maximumGain, Math.max(1, gain));
      await cameraController.setWhiteBalanceLocked({
        redGain: clampGain(daylightGains.redGain),
        greenGain: clampGain(daylightGains.greenGain),
        blueGain: clampGain(daylightGains.blueGain),
      });
      setWhiteBalanceStatus('lockedDaylight');
      return true;
    } catch {
      // Android: no hay ganancias a mano; se congela el balance automático actual.
      try {
        await cameraController.lockCurrentWhiteBalance();
        setWhiteBalanceStatus('lockedCurrent');
        return true;
      } catch {
        setWhiteBalanceStatus('failed');
        return false;
      }
    }
  }, [cameraDevice, cameraRef, isSupported]);

  return { isSupported, whiteBalanceStatus: isSupported ? whiteBalanceStatus : ('unsupported' as const), applyDaylightWhiteBalance };
}
