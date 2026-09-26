/**
 * «Afinar el enfoque» del superzoom: antes de la ráfaga, unas pocas fotos con el enfoque manual
 * (`setFocusLocked`) en varias posiciones, puntuadas con Tenengrad en el recuadro
 * (`measureSceneFocusScore`); se deja fijada la mejor y la ráfaga se dispara ahí.
 *
 * Posiciones en la escala de VisionCamera (0 = lo más cerca, 1 = infinito; en Android, lineal en
 * dioptrías). Si la cámara dice dónde está el objetivo (iOS), la horquilla se centra ahí; en
 * Android `lensPosition` solo se conoce después de fijarlo a mano, así que se explora el último
 * 20 % del recorrido (de ~50 cm al infinito con un objetivo que enfoca a 10 cm), que es donde
 * está lo que se amplía con el superzoom. Como mucho dos series de cinco fotos: la segunda,
 * más fina, alrededor de la mejor de la primera (`proposeNextFocusSeries`).
 *
 * Solo si la cámara admite el enfoque manual (`supportsFocusLocking`).
 */
import { type RefObject, useCallback, useState } from 'react';
import type { CameraDevice, CameraRef } from 'react-native-vision-camera';

import type { PhotoBurstRequest, PhotoBurstResult } from '@/core/camera/usePhotoBurst';
import { estimateBestFocus, type FocusMeasurement, type FocusSeriesOptions, proposeNextFocusSeries } from '@/processing/image/focusBracketing';
import { focusBracketPositions, measureSceneFocusScore } from '@/processing/image/sceneFocusScore';

const localBracketStep = 0.04;
const bracketStepCount = 5;
const maximumSeriesCount = 2;
/** Rango que se explora si no se sabe dónde está el objetivo. */
const unknownPositionRange = { minimumPosition: 0.8, maximumPosition: 1 };
/** Espera para que el objetivo llegue a la posición antes de disparar. */
const lensSettleMilliseconds = 250;
/** Las fotos de prueba se reducen a este lado: basta para puntuar y se decodifican antes. */
const testPhotoMaximumSide = 512;

export interface FocusTuningProgress {
  measuredCount: number;
  plannedCount: number;
}

export interface FocusTuningOutcome {
  bestLensPosition: number;
  testPhotoCount: number;
  /** La mejor tenía peores a ambos lados (el óptimo está dentro de lo medido). */
  isBracketed: boolean;
}

function waitMilliseconds(durationMilliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, durationMilliseconds));
}

export function useSuperzoomFocusTuning(
  cameraRef: RefObject<CameraRef | null>,
  cameraDevice: CameraDevice | undefined,
  captureBurst: (burstRequest: PhotoBurstRequest) => Promise<PhotoBurstResult>,
) {
  const isSupported = Boolean(cameraDevice?.supportsFocusLocking);
  const [progress, setProgress] = useState<FocusTuningProgress | null>(null);

  const tuneFocus = useCallback(
    async (planCrop: PhotoBurstRequest['planCrop']): Promise<FocusTuningOutcome | null> => {
      const cameraController = cameraRef.current?.controller;
      if (!isSupported || !cameraController) return null;
      const currentPosition = cameraController.lensPosition;
      const isPositionKnown = Number.isFinite(currentPosition) && currentPosition > 0 && currentPosition <= 1;
      const seriesOptions: FocusSeriesOptions = isPositionKnown
        ? { stepCount: bracketStepCount, minimumStepSize: 0.01, minimumPosition: 0, maximumPosition: 1 }
        : { stepCount: bracketStepCount, minimumStepSize: 0.01, ...unknownPositionRange };
      let nextPositions = isPositionKnown
        ? focusBracketPositions(currentPosition, localBracketStep, bracketStepCount)
        : focusBracketPositions((unknownPositionRange.minimumPosition + unknownPositionRange.maximumPosition) / 2, 0.05, bracketStepCount);
      const measurements: FocusMeasurement[] = [];
      try {
        for (let seriesIndex = 0; seriesIndex < maximumSeriesCount && nextPositions.length > 0; seriesIndex++) {
          const plannedCount = measurements.length + nextPositions.length;
          for (const lensPosition of nextPositions) {
            setProgress({ measuredCount: measurements.length, plannedCount });
            await cameraController.setFocusLocked(lensPosition);
            await waitMilliseconds(lensSettleMilliseconds);
            const burstResult = await captureBurst({ photoCount: 1, planCrop, maximumOutputSide: testPhotoMaximumSide });
            const testCrop = burstResult.crops[0];
            if (!testCrop) continue;
            measurements.push({ focusPosition: lensPosition, score: measureSceneFocusScore(testCrop.rgbPixels, testCrop.width, testCrop.height) });
          }
          const proposal = proposeNextFocusSeries(measurements, seriesOptions);
          if (proposal.hasConverged) break;
          nextPositions = proposal.nextPositions;
        }
        const bestFocus = estimateBestFocus(measurements);
        if (!bestFocus) return null;
        await cameraController.setFocusLocked(bestFocus.estimatedBestPosition);
        await waitMilliseconds(lensSettleMilliseconds);
        return {
          bestLensPosition: bestFocus.estimatedBestPosition,
          testPhotoCount: measurements.length,
          isBracketed: bestFocus.isBracketed,
        };
      } finally {
        setProgress(null);
      }
    },
    [cameraRef, captureBurst, isSupported],
  );

  return { isSupported, progress, isRunning: progress !== null, tuneFocus };
}
