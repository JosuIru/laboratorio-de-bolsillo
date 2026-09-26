/**
 * «Afinar el enfoque»: horquilla de enfoque manual cerca del infinito. Para cada posición del
 * objetivo se fija el enfoque (`setFocusLocked`), se toma una ráfaga corta, se puntúa la nitidez
 * del limbo y del interior (`measureLunarFocusScore`) y se propone una serie más fina alrededor
 * de la mejor (`proposeNextFocusSeries`). La mejor posición se recuerda durante la sesión y se
 * vuelve a fijar antes de cada captura (tocar la pantalla o `resetFocus` la quitan).
 *
 * Solo funciona si la cámara admite el enfoque manual (`supportsFocusLocking`). En Android,
 * VisionCamera 5.2.3 todavía no lo implementa (CameraX): allí la función queda desactivada y
 * se explica en pantalla.
 */
import { type RefObject, useCallback, useRef, useState } from 'react';
import type { CameraDevice, CameraRef } from 'react-native-vision-camera';

import type { PhotoBurstRequest, PhotoBurstResult } from '@/core/camera/usePhotoBurst';
import {
  estimateBestFocus,
  type FocusMeasurement,
  type FocusSeriesOptions,
  initialFocusSeries,
  measureLunarFocusScore,
  proposeNextFocusSeries,
} from '@/processing/image/focusBracketing';
import { grayImageFromRgb } from '@/processing/image/grayImage';

/**
 * Posiciones del objetivo en la escala de VisionCamera (0 = lo más cerca, 1 = lo más lejos).
 * La Luna está en el infinito: se explora el último 20 % del recorrido.
 */
const lunarFocusSeriesOptions: FocusSeriesOptions = {
  stepCount: 5,
  minimumStepSize: 0.01,
  minimumPosition: 0.8,
  maximumPosition: 1,
};
const maximumSeriesCount = 4;
const photosPerPosition = 2;
/** Espera para que el objetivo llegue a la posición antes de disparar. */
const lensSettleMilliseconds = 300;

export interface FocusBracketingProgress {
  seriesNumber: number;
  measuredCount: number;
  lensPosition: number;
}

export interface FocusBracketingOutcome {
  bestLensPosition: number;
  measurements: FocusMeasurement[];
  hasConverged: boolean;
}

interface FocusBracketingDependencies {
  cameraRef: RefObject<CameraRef | null>;
  cameraDevice: CameraDevice | undefined;
  captureBurst(burstRequest: PhotoBurstRequest): Promise<PhotoBurstResult>;
}

function waitMilliseconds(durationMilliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, durationMilliseconds));
}

export function useFocusBracketing({ cameraRef, cameraDevice, captureBurst }: FocusBracketingDependencies) {
  const isSupported = Boolean(cameraDevice?.supportsFocusLocking);
  const [bestLensPosition, setBestLensPosition] = useState<number | null>(null);
  const [progress, setProgress] = useState<FocusBracketingProgress | null>(null);
  const [lastOutcome, setLastOutcome] = useState<FocusBracketingOutcome | null>(null);
  const isStopRequestedRef = useRef(false);

  const runFocusBracketing = useCallback(
    async (planCrop: PhotoBurstRequest['planCrop']): Promise<FocusBracketingOutcome | null> => {
      const cameraController = cameraRef.current?.controller;
      if (!isSupported || !cameraController) return null;
      isStopRequestedRef.current = false;
      const measurements: FocusMeasurement[] = [];
      let nextPositions = initialFocusSeries(lunarFocusSeriesOptions);
      let hasConverged = false;
      try {
        for (let seriesIndex = 0; seriesIndex < maximumSeriesCount && nextPositions.length > 0; seriesIndex++) {
          for (const lensPosition of nextPositions) {
            if (isStopRequestedRef.current) break;
            setProgress({ seriesNumber: seriesIndex + 1, measuredCount: measurements.length, lensPosition });
            await cameraController.setFocusLocked(lensPosition);
            await waitMilliseconds(lensSettleMilliseconds);
            const burstResult = await captureBurst({ photoCount: photosPerPosition, planCrop, maximumOutputSide: 512 });
            // La mejor de las fotos de cada posición: la turbulencia emborrona unas más que otras.
            const bestScore = Math.max(
              0,
              ...burstResult.crops.map(
                (photoCrop) => measureLunarFocusScore(grayImageFromRgb(photoCrop.rgbPixels, photoCrop.width, photoCrop.height))?.score ?? 0,
              ),
            );
            if (bestScore > 0) measurements.push({ focusPosition: lensPosition, score: bestScore });
          }
          if (isStopRequestedRef.current) break;
          const proposal = proposeNextFocusSeries(measurements, lunarFocusSeriesOptions);
          hasConverged = proposal.hasConverged;
          nextPositions = proposal.nextPositions;
        }
        const bestFocus = estimateBestFocus(measurements);
        if (!bestFocus) return null;
        await cameraController.setFocusLocked(bestFocus.estimatedBestPosition);
        const outcome = { bestLensPosition: bestFocus.estimatedBestPosition, measurements, hasConverged };
        setBestLensPosition(outcome.bestLensPosition);
        setLastOutcome(outcome);
        return outcome;
      } finally {
        setProgress(null);
      }
    },
    [cameraRef, captureBurst, isSupported],
  );

  /** Vuelve a fijar la mejor posición (antes de capturar, o tras `resetFocus`). */
  const reapplyBestFocus = useCallback(async () => {
    const cameraController = cameraRef.current?.controller;
    if (!isSupported || bestLensPosition === null || !cameraController) return false;
    try {
      await cameraController.setFocusLocked(bestLensPosition);
      return true;
    } catch {
      return false;
    }
  }, [bestLensPosition, cameraRef, isSupported]);

  const stopFocusBracketing = useCallback(() => {
    isStopRequestedRef.current = true;
  }, []);

  const forgetBestFocus = useCallback(() => {
    setBestLensPosition(null);
    setLastOutcome(null);
  }, []);

  return {
    isSupported,
    bestLensPosition,
    lastOutcome,
    progress,
    isRunning: progress !== null,
    runFocusBracketing,
    reapplyBestFocus,
    stopFocusBracketing,
    forgetBestFocus,
  };
}
