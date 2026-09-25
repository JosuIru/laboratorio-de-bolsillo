import { useCallback, useRef, useState } from 'react';
import { CommonResolutions, type Frame, useFrameOutput } from 'react-native-vision-camera';
import { scheduleOnRN } from 'react-native-worklets';

import {
  createSrgbToLinearTable,
  measureRegionColor,
  type PixelLayout,
  type RegionColorStatistics,
} from '@/processing/color/regionSampling';

import { createRegionAverager } from '@instruments/colorimeter/colorimeterEngine';

/** Lado de la región de la mira, como fracción del lado menor del fotograma. */
export const crosshairSizeFraction = 0.08;
/** Lecturas por segundo en el hilo JS: más que el colorímetro, para que la pista responda rápido. */
const maximumReadingsPerSecond = 8;
/** Lecturas que se promedian (≈ 0,5 s): estable pero sin retraso molesto al mover el móvil. */
const averagedReadingCount = 4;

/**
 * Como `useColorimeterFrames`, pero con una única región fija en el centro del fotograma (la
 * mira). Con la vista previa en modo `cover` el centro del fotograma es el centro de la vista,
 * así que no hace falta convertir coordenadas.
 */
export function useCrosshairFrames() {
  const [srgbToLinearTable] = useState(createSrgbToLinearTable);
  const [latestCrosshairRegion, setLatestCrosshairRegion] = useState<RegionColorStatistics | null>(null);
  const lastDeliveryTime = useRef(0);
  const [regionAverager] = useState(() => createRegionAverager(averagedReadingCount));

  const deliverRegion = useCallback(
    (measuredRegion: RegionColorStatistics | null) => {
      const currentTime = Date.now();
      if (currentTime - lastDeliveryTime.current < 1000 / maximumReadingsPerSecond) return;
      lastDeliveryTime.current = currentTime;
      setLatestCrosshairRegion(regionAverager.push([measuredRegion])[0] ?? null);
    },
    [regionAverager],
  );

  /** Olvida el promedio (p. ej. al empezar un turno). */
  const resetAverage = useCallback(() => {
    regionAverager.reset();
    setLatestCrosshairRegion(null);
  }, [regionAverager]);

  const handleFrame = useCallback(
    (frame: Frame) => {
      'worklet';
      if (!frame.hasPixelBuffer) {
        frame.dispose();
        return;
      }
      const pixelFormat = frame.pixelFormat;
      const pixelLayout: PixelLayout =
        pixelFormat === 'rgb-bgra-8-bit' ? 'bgra' : frame.bytesPerRow >= frame.width * 4 ? 'rgba' : 'rgb';
      const pixels = new Uint8Array(frame.getPixelBuffer());
      const regionSidePixels = Math.min(frame.width, frame.height) * crosshairSizeFraction;
      const regionWidthFraction = regionSidePixels / frame.width;
      const regionHeightFraction = regionSidePixels / frame.height;
      const measuredRegion = measureRegionColor(
        pixels,
        frame.width,
        frame.height,
        frame.bytesPerRow,
        pixelLayout,
        {
          left: 0.5 - regionWidthFraction / 2,
          top: 0.5 - regionHeightFraction / 2,
          width: regionWidthFraction,
          height: regionHeightFraction,
        },
        srgbToLinearTable,
        2,
      );
      frame.dispose();
      scheduleOnRN(deliverRegion, measuredRegion);
    },
    [srgbToLinearTable, deliverRegion],
  );

  const frameOutput = useFrameOutput({
    // Resolución baja: para promediar una región sobra y el procesado es mucho más ligero.
    targetResolution: CommonResolutions.VGA_4_3,
    pixelFormat: 'rgb',
    onFrame: handleFrame,
  });

  return { frameOutput, latestCrosshairRegion, resetAverage };
}
