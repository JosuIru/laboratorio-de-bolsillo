import { type RefObject, useCallback, useState } from 'react';
import type { CameraRef } from 'react-native-vision-camera';

import { clampIso, nightExposureSeconds } from './skyCapturePlanning';

/** Posición de la lente en el infinito, en la escala 0-1 de `setFocusLocked`. */
const infinityLensPosition = 1;

export interface AppliedNightSettings {
  /** null: el móvil no deja fijar la exposición (se queda en automática). */
  exposureSeconds: number | null;
  iso: number | null;
  isFocusAtInfinity: boolean;
  isWhiteBalanceLocked: boolean;
}

/**
 * Ajustes de cámara para el cielo nocturno: la exposición más larga que permite el móvil con el
 * ISO elegido, enfoque fijo en el infinito (el enfoque automático no encuentra las estrellas y
 * va y viene) y balance de blancos congelado. `resetToAutomatic` los quita.
 */
export function useNightCamera(cameraRef: RefObject<CameraRef | null>) {
  const [appliedSettings, setAppliedSettings] = useState<AppliedNightSettings | null>(null);

  const applyNightSettings = useCallback(
    async (requestedIso: number): Promise<AppliedNightSettings | null> => {
      const cameraController = cameraRef.current?.controller;
      if (!cameraController) return null;
      const cameraDevice = cameraController.device;
      const nightSettings: AppliedNightSettings = {
        exposureSeconds: null,
        iso: null,
        isFocusAtInfinity: false,
        isWhiteBalanceLocked: false,
      };
      if (cameraDevice.supportsExposureLocking && cameraController.maxExposureDuration > 0) {
        const exposureSeconds = nightExposureSeconds(cameraController.maxExposureDuration);
        const iso = clampIso(requestedIso, cameraController.minISO, cameraController.maxISO);
        try {
          await cameraController.setExposureLocked(exposureSeconds, iso);
          nightSettings.exposureSeconds = exposureSeconds;
          nightSettings.iso = iso;
        } catch {
          // No admitido: se queda con la exposición automática.
        }
      }
      if (cameraDevice.supportsFocusLocking) {
        try {
          await cameraController.setFocusLocked(infinityLensPosition);
          nightSettings.isFocusAtInfinity = true;
        } catch {
          // Sin enfoque manual: el automático puede dudar con las estrellas.
        }
      }
      if (cameraDevice.supportsWhiteBalanceLocking) {
        try {
          await cameraController.lockCurrentWhiteBalance();
          nightSettings.isWhiteBalanceLocked = true;
        } catch {
          // No admitido: el color puede variar un poco entre fotos.
        }
      }
      setAppliedSettings(nightSettings);
      return nightSettings;
    },
    [cameraRef],
  );

  const resetToAutomatic = useCallback(async () => {
    setAppliedSettings(null);
    try {
      await cameraRef.current?.resetFocus();
    } catch {
      // La cámara puede no estar lista; no hay nada que deshacer.
    }
  }, [cameraRef]);

  return { appliedSettings, applyNightSettings, resetToAutomatic };
}
