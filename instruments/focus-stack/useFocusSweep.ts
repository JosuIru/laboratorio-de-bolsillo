/**
 * Captura del «macro enfocado»: congela la exposición y el balance de blancos, (opcionalmente)
 * sondea el enfoque con unas fotos pequeñas para saber dónde está el objeto y luego toma una foto
 * por posición del barrido (`setFocusLocked`, de cerca a lejos). Cada foto se toma y se recorta
 * antes de mover el objetivo a la siguiente posición.
 *
 * Solo si la cámara admite el enfoque manual (`supportsFocusLocking`).
 */
import { type RefObject, useCallback, useRef, useState } from 'react';
import type { CameraDevice, CameraRef } from 'react-native-vision-camera';

import type { PhotoBurstCrop, PhotoBurstRequest, PhotoBurstResult } from '@/core/camera/usePhotoBurst';
import {
  type FocusProbeMeasurement,
  focusProbePositions,
  type FocusRange,
  type FocusSweepPlan,
  measureTileFocusScores,
  planFocusSweepForRange,
  planFocusSweepFromProbe,
} from '@/processing/image/focusSweepPlanning';

/** Espera para que el objetivo llegue a la posición antes de disparar. */
const lensSettleMilliseconds = 250;
/** Las fotos del sondeo se reducen a este lado: basta para puntuar casillas y se decodifican antes. */
const probePhotoMaximumSide = 384;
const probeTilesPerSide = 4;

export type FocusRangeMode = 'auto' | 'macro' | 'near';

/** Rangos fijos (posición 0 = lo más cerca). Con enfoque mínimo a 10 cm: ~10-18 cm y ~14-50 cm. */
export const fixedFocusRanges: Record<Exclude<FocusRangeMode, 'auto'>, FocusRange> = {
  macro: { nearPosition: 0, farPosition: 0.45 },
  near: { nearPosition: 0.3, farPosition: 0.8 },
};

export interface FocusSweepProgress {
  phase: 'probing' | 'sweeping';
  completedCount: number;
  totalCount: number;
}

export interface FocusSweepOutcome {
  crops: PhotoBurstCrop[];
  /** Posición del objetivo de cada recorte (en el mismo orden). */
  lensPositions: number[];
  plan: FocusSweepPlan;
  probePhotoCount: number;
  hasLockedExposure: boolean;
  hasLockedWhiteBalance: boolean;
  probeMilliseconds: number;
  sweepMilliseconds: number;
  /** Parte del barrido que fue leer y recortar las fotos. */
  decodeMilliseconds: number;
  wasStopped: boolean;
  firstErrorMessage: string | null;
}

function waitMilliseconds(durationMilliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, durationMilliseconds));
}

export function useFocusSweep(
  cameraRef: RefObject<CameraRef | null>,
  cameraDevice: CameraDevice | undefined,
  captureBurst: (burstRequest: PhotoBurstRequest) => Promise<PhotoBurstResult>,
) {
  const isSupported = Boolean(cameraDevice?.supportsFocusLocking);
  const [progress, setProgress] = useState<FocusSweepProgress | null>(null);
  const isStopRequestedRef = useRef(false);

  const stopSweep = useCallback(() => {
    isStopRequestedRef.current = true;
  }, []);

  const runSweep = useCallback(
    async (
      rangeMode: FocusRangeMode,
      planCrop: PhotoBurstRequest['planCrop'],
      maximumOutputSide: number | undefined,
    ): Promise<FocusSweepOutcome | null> => {
      const cameraController = cameraRef.current?.controller;
      if (!isSupported || !cameraController) return null;
      isStopRequestedRef.current = false;
      let firstErrorMessage: string | null = null;

      // Exposición y balance congelados: si cambian entre fotos, la fusión mezcla brillos distintos.
      let hasLockedExposure = false;
      if (cameraDevice?.supportsExposureLocking && cameraController.exposureDuration > 0 && cameraController.iso > 0) {
        try {
          await cameraController.setExposureLocked(cameraController.exposureDuration, cameraController.iso);
          hasLockedExposure = true;
        } catch {
          // No admitido: se sigue con la exposición automática.
        }
      }
      let hasLockedWhiteBalance = false;
      if (cameraDevice?.supportsWhiteBalanceLocking) {
        try {
          await cameraController.lockCurrentWhiteBalance();
          hasLockedWhiteBalance = true;
        } catch {
          // No admitido en este móvil.
        }
      }

      try {
        async function captureAtPosition(lensPosition: number, outputSide: number | undefined): Promise<PhotoBurstResult | null> {
          await cameraController!.setFocusLocked(lensPosition);
          await waitMilliseconds(lensSettleMilliseconds);
          const burstResult = await captureBurst({ photoCount: 1, planCrop, maximumOutputSide: outputSide });
          firstErrorMessage ??= burstResult.firstErrorMessage;
          return burstResult;
        }

        // 1. Sondeo (solo en automático).
        const probeStartTime = Date.now();
        let plan: FocusSweepPlan;
        let probePhotoCount = 0;
        if (rangeMode === 'auto') {
          const probeMeasurements: FocusProbeMeasurement[] = [];
          for (const lensPosition of focusProbePositions) {
            if (isStopRequestedRef.current) return null;
            setProgress({ phase: 'probing', completedCount: probeMeasurements.length, totalCount: focusProbePositions.length });
            const probeResult = await captureAtPosition(lensPosition, probePhotoMaximumSide);
            const probeCrop = probeResult?.crops[0];
            probePhotoCount++;
            if (!probeCrop) continue;
            probeMeasurements.push({
              lensPosition,
              tileScores: measureTileFocusScores(probeCrop.rgbPixels, probeCrop.width, probeCrop.height, probeTilesPerSide),
            });
          }
          plan = planFocusSweepFromProbe(probeMeasurements);
        } else {
          plan = { ...planFocusSweepForRange(fixedFocusRanges[rangeMode]), usedTileCount: 0, isFallback: false };
        }
        const probeMilliseconds = Date.now() - probeStartTime;

        // 2. Barrido de cerca a lejos.
        const sweepStartTime = Date.now();
        const crops: PhotoBurstCrop[] = [];
        const lensPositions: number[] = [];
        let decodeMilliseconds = 0;
        for (const lensPosition of plan.positions) {
          if (isStopRequestedRef.current) break;
          setProgress({ phase: 'sweeping', completedCount: crops.length, totalCount: plan.positions.length });
          const sweepResult = await captureAtPosition(lensPosition, maximumOutputSide);
          decodeMilliseconds += sweepResult?.timings.decodeMilliseconds ?? 0;
          const sweepCrop = sweepResult?.crops[0];
          if (!sweepCrop) continue;
          crops.push(sweepCrop);
          lensPositions.push(lensPosition);
        }
        return {
          crops,
          lensPositions,
          plan,
          probePhotoCount,
          hasLockedExposure,
          hasLockedWhiteBalance,
          probeMilliseconds,
          sweepMilliseconds: Date.now() - sweepStartTime,
          decodeMilliseconds,
          wasStopped: isStopRequestedRef.current,
          firstErrorMessage,
        };
      } finally {
        setProgress(null);
        // Vuelta al enfoque, la exposición y el balance automáticos.
        cameraRef.current?.resetFocus().catch(() => undefined);
      }
    },
    [cameraDevice, cameraRef, captureBurst, isSupported],
  );

  return { isSupported, progress, isRunning: progress !== null, runSweep, stopSweep };
}
