import { useCallback, useRef, useState } from 'react';
import { CommonResolutions, type Frame, useFrameOutput } from 'react-native-vision-camera';
import { scheduleOnRN } from 'react-native-worklets';

import { createSrgbToLinearTable, type PixelLayout, type RegionColorStatistics } from '@/processing/color/regionSampling';
import { measureRegionColorRobust } from '@/processing/color/robustRegionSampling';

import { createRegionAverager } from '@instruments/colorimeter/colorimeterEngine';

import type { CameraRegion } from './stripEngine';

/** Actualizaciones de la lectura por segundo en el hilo JS (el procesado va en el hilo de cámara). */
const maximumReadingsPerSecond = 5;
/** Lecturas que se promedian para estabilizar el color (≈ 1,6 s). */
const averagedReadingCount = 8;

/**
 * Como `useColorimeterFrames`, pero con regiones rectangulares (una por almohadilla o parche) y
 * media robusta dentro de cada una, para que los reflejos de la tira mojada no cuenten.
 * `null` = región sin colocar. Las regiones que devuelve están promediadas en las últimas
 * lecturas y se olvidan al cambiar la lista de regiones.
 */
export function useStripFrames(cameraRegions: readonly (CameraRegion | null)[]) {
  const [srgbToLinearTable] = useState(createSrgbToLinearTable);
  const lastDeliveryTime = useRef(0);
  const [latestDelivery, setLatestDelivery] = useState<{
    sourceRegions: readonly (CameraRegion | null)[];
    averagedRegions: (RegionColorStatistics | null)[];
  } | null>(null);
  // Un promedio nuevo por cada lista de regiones: al mover la guía no se mezclan colores viejos.
  const [regionAverager, setRegionAverager] = useState(() => createRegionAverager(averagedReadingCount));
  const [averagedCameraRegions, setAveragedCameraRegions] = useState(cameraRegions);
  if (averagedCameraRegions !== cameraRegions) {
    setAveragedCameraRegions(cameraRegions);
    setRegionAverager(createRegionAverager(averagedReadingCount));
  }

  const deliverRegions = useCallback(
    (measuredRegions: (RegionColorStatistics | null)[]) => {
      const currentTime = Date.now();
      if (currentTime - lastDeliveryTime.current < 1000 / maximumReadingsPerSecond) return;
      lastDeliveryTime.current = currentTime;
      setLatestDelivery({ sourceRegions: cameraRegions, averagedRegions: regionAverager.push(measuredRegions) });
    },
    [cameraRegions, regionAverager],
  );

  const handleFrame = useCallback(
    (frame: Frame) => {
      'worklet';
      if (!frame.hasPixelBuffer) {
        frame.dispose();
        return;
      }
      const pixelLayout: PixelLayout =
        frame.pixelFormat === 'rgb-bgra-8-bit' ? 'bgra' : frame.bytesPerRow >= frame.width * 4 ? 'rgba' : 'rgb';
      const pixels = new Uint8Array(frame.getPixelBuffer());

      const measuredRegions: (RegionColorStatistics | null)[] = [];
      for (const cameraRegion of cameraRegions) {
        if (!cameraRegion) {
          measuredRegions.push(null);
          continue;
        }
        // La imagen puede venir girada respecto a la vista: se convierten las dos esquinas.
        const firstFramePoint = frame.convertCameraPointToFramePoint(cameraRegion.firstCorner);
        const secondFramePoint = frame.convertCameraPointToFramePoint(cameraRegion.secondCorner);
        const leftPixel = Math.min(firstFramePoint.x, secondFramePoint.x);
        const topPixel = Math.min(firstFramePoint.y, secondFramePoint.y);
        measuredRegions.push(
          measureRegionColorRobust(
            pixels,
            frame.width,
            frame.height,
            frame.bytesPerRow,
            pixelLayout,
            {
              left: leftPixel / frame.width,
              top: topPixel / frame.height,
              width: Math.abs(secondFramePoint.x - firstFramePoint.x) / frame.width,
              height: Math.abs(secondFramePoint.y - firstFramePoint.y) / frame.height,
            },
            srgbToLinearTable,
            2,
          ),
        );
      }
      frame.dispose();
      scheduleOnRN(deliverRegions, measuredRegions);
    },
    [cameraRegions, srgbToLinearTable, deliverRegions],
  );

  const frameOutput = useFrameOutput({
    // Resolución baja: para promediar regiones sobra y el procesado es mucho más ligero.
    targetResolution: CommonResolutions.VGA_4_3,
    pixelFormat: 'rgb',
    onFrame: handleFrame,
  });

  const latestRegions = latestDelivery && latestDelivery.sourceRegions === cameraRegions ? latestDelivery.averagedRegions : null;
  return { frameOutput, latestRegions };
}
