import { useCallback, useRef, useState } from 'react';
import { CommonResolutions, type Frame, useFrameOutput } from 'react-native-vision-camera';
import { scheduleOnRN } from 'react-native-worklets';

import { readFramePixels } from '@/core/camera/framePixels';
import { createSrgbToLinearTable } from '@/processing/color/regionSampling';

import type { CameraPoint } from '@instruments/colorimeter/useColorimeterFrames';

import { blendProfiles, profileSampleCount, sampleProfileAlongLine } from './spectrumEngine';

/** Actualizaciones por segundo en el hilo JS (el muestreo va en el hilo de la cámara). */
const maximumProfilesPerSecond = 8;
/** Peso de cada perfil nuevo en la media: ~1 s de memoria a 8 perfiles por segundo. */
const newProfileWeight = 0.25;
/** Media tira perpendicular que se promedia en cada punto de la línea (píxeles). */
const halfThicknessPixels = 4;

export interface CameraLine {
  start: CameraPoint;
  end: CameraPoint;
}

export interface SpectrumProfile {
  intensities: Float64Array;
  reds: Float64Array;
  greens: Float64Array;
  blues: Float64Array;
  /** Fracción de puntos de la línea con píxeles saturados en el último fotograma. */
  saturatedFraction: number;
  revision: number;
}

/**
 * Lee en cada fotograma la intensidad a lo largo de la línea guía (convertida a coordenadas de
 * cámara) y devuelve la media de los últimos perfiles. Al mover la línea se empieza de cero.
 */
export function useSpectrumFrames(cameraLine: CameraLine | null) {
  const [srgbToLinearTable] = useState(createSrgbToLinearTable);
  const lastDeliveryTime = useRef(0);
  const [spectrumProfile, setSpectrumProfile] = useState<SpectrumProfile | null>(null);
  const [profiledLine, setProfiledLine] = useState(cameraLine);
  if (profiledLine !== cameraLine) {
    setProfiledLine(cameraLine);
    setSpectrumProfile(null);
  }

  const deliverProfile = useCallback(
    (
      newIntensities: Float64Array,
      newReds: Float64Array,
      newGreens: Float64Array,
      newBlues: Float64Array,
      saturatedSampleCount: number,
    ) => {
      const currentTime = Date.now();
      if (currentTime - lastDeliveryTime.current < 1000 / maximumProfilesPerSecond) return;
      lastDeliveryTime.current = currentTime;
      setSpectrumProfile((previousProfile) => ({
        intensities: blendProfiles(previousProfile?.intensities ?? null, newIntensities, newProfileWeight),
        reds: blendProfiles(previousProfile?.reds ?? null, newReds, newProfileWeight),
        greens: blendProfiles(previousProfile?.greens ?? null, newGreens, newProfileWeight),
        blues: blendProfiles(previousProfile?.blues ?? null, newBlues, newProfileWeight),
        saturatedFraction: saturatedSampleCount / newIntensities.length,
        revision: (previousProfile?.revision ?? 0) + 1,
      }));
    },
    [],
  );

  const handleFrame = useCallback(
    (frame: Frame) => {
      'worklet';
      const framePixels = readFramePixels(frame);
      if (!framePixels || !cameraLine) {
        frame.dispose();
        return;
      }
      const startPoint = frame.convertCameraPointToFramePoint(cameraLine.start);
      const endPoint = frame.convertCameraPointToFramePoint(cameraLine.end);
      const { intensities, reds, greens, blues, saturatedSampleCount } = sampleProfileAlongLine(
        framePixels.pixels,
        framePixels.width,
        framePixels.height,
        framePixels.bytesPerRow,
        framePixels.pixelLayout,
        startPoint,
        endPoint,
        profileSampleCount,
        halfThicknessPixels,
        srgbToLinearTable,
      );
      frame.dispose();
      scheduleOnRN(deliverProfile, intensities, reds, greens, blues, saturatedSampleCount);
    },
    [cameraLine, deliverProfile, srgbToLinearTable],
  );

  const frameOutput = useFrameOutput({
    // Resolución media: suficiente para separar las líneas de un fluorescente sin cargar el móvil.
    targetResolution: CommonResolutions.HD_16_9,
    pixelFormat: 'rgb',
    onFrame: handleFrame,
  });

  return { frameOutput, spectrumProfile: profiledLine === cameraLine ? spectrumProfile : null };
}
