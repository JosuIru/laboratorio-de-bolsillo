import { useCallback, useRef, useState } from 'react';
import { CommonResolutions, type Frame, useFrameOutput } from 'react-native-vision-camera';
import { scheduleOnRN } from 'react-native-worklets';

import { readFramePixels } from '@/core/camera/framePixels';
import {
  createSrgbToLinearTable,
  measureRegionColor,
  type RegionColorStatistics,
} from '@/processing/color/regionSampling';

import { createRegionAverager } from './colorimeterEngine';

/** Punto en el sistema de coordenadas de la cámara (lo da la vista previa al tocarla). */
export interface CameraPoint {
  x: number;
  y: number;
}

/** Lado de cada región de muestreo, como fracción del lado menor del fotograma. */
export const regionSizeFraction = 0.05;
/** Actualizaciones de la lectura por segundo en el hilo JS (el procesado va en el hilo de cámara). */
const maximumReadingsPerSecond = 6;
/** Lecturas que se promedian para estabilizar el color (≈ 1,3 s). */
const averagedReadingCount = 8;

/**
 * Procesa cada fotograma en el hilo de la cámara (worklet): mide el color medio de la región de
 * muestra y de cada parche de referencia, y envía solo esos pocos números al hilo JS.
 * `regionCenters[0]` es la muestra; el resto, los parches. `null` = región sin colocar.
 * Las regiones que devuelve están promediadas en las últimas lecturas.
 */
export function useColorimeterFrames(regionCenters: readonly (CameraPoint | null)[]) {
  const [srgbToLinearTable] = useState(createSrgbToLinearTable);
  const [latestRegions, setLatestRegions] = useState<(RegionColorStatistics | null)[] | null>(null);
  const lastDeliveryTime = useRef(0);
  const [regionAverager] = useState(() => createRegionAverager(averagedReadingCount));

  const deliverRegions = useCallback((measuredRegions: (RegionColorStatistics | null)[]) => {
    const currentTime = Date.now();
    if (currentTime - lastDeliveryTime.current < 1000 / maximumReadingsPerSecond) return;
    lastDeliveryTime.current = currentTime;
    setLatestRegions(regionAverager.push(measuredRegions));
  }, [regionAverager]);

  /** Olvida el promedio (p. ej. al mover un marcador). */
  const resetAverage = useCallback(() => {
    regionAverager.reset();
    setLatestRegions(null);
  }, [regionAverager]);

  const handleFrame = useCallback(
    (frame: Frame) => {
      'worklet';
      const framePixels = readFramePixels(frame);
      if (!framePixels) {
        frame.dispose();
        return;
      }
      const { pixels, pixelLayout } = framePixels;
      const halfRegionPixels = (Math.min(frame.width, frame.height) * regionSizeFraction) / 2;

      const measuredRegions: (RegionColorStatistics | null)[] = [];
      for (const regionCenter of regionCenters) {
        if (!regionCenter) {
          measuredRegions.push(null);
          continue;
        }
        const framePoint = frame.convertCameraPointToFramePoint(regionCenter);
        measuredRegions.push(
          measureRegionColor(
            pixels,
            frame.width,
            frame.height,
            frame.bytesPerRow,
            pixelLayout,
            {
              left: (framePoint.x - halfRegionPixels) / frame.width,
              top: (framePoint.y - halfRegionPixels) / frame.height,
              width: (2 * halfRegionPixels) / frame.width,
              height: (2 * halfRegionPixels) / frame.height,
            },
            srgbToLinearTable,
            2,
          ),
        );
      }
      frame.dispose();
      scheduleOnRN(deliverRegions, measuredRegions);
    },
    [regionCenters, srgbToLinearTable, deliverRegions],
  );

  const frameOutput = useFrameOutput({
    // Resolución baja: para promediar regiones sobra y el procesado es mucho más ligero.
    targetResolution: CommonResolutions.VGA_4_3,
    pixelFormat: 'rgb',
    onFrame: handleFrame,
  });

  return { frameOutput, latestRegions, resetAverage };
}
