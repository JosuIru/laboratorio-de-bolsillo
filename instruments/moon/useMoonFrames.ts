import { useCallback, useEffect, useRef, useState } from 'react';
import { CommonResolutions, type Frame, useFrameOutput } from 'react-native-vision-camera';
import { scheduleOnRN } from 'react-native-worklets';

import { readFramePixels } from '@/core/camera/framePixels';
import { type BrightObjectDetection, locateBrightObject } from '@/processing/image/lunarStacking';

/** Detecciones por segundo que se envían al hilo JS. */
const maximumDetectionsPerSecond = 4;
/** Salto de píxeles al buscar la Luna: con fotogramas de 768×1024 va de sobra y es ligero. */
const detectionSampleStride = 2;

export interface LiveMoonDetection extends BrightObjectDetection {
  frameWidth: number;
  frameHeight: number;
}

/**
 * Localiza la Luna en los fotogramas de la vista previa (en el hilo de la cámara) y envía unas
 * pocas cifras (posición, tamaño, saturación) para apuntar, medir la luz y saber dónde recortar
 * las fotos de la ráfaga. Las fotos se toman aparte, a resolución completa.
 * `onDetection` recibe cada detección que llega al hilo JS (para ajustar la exposición).
 */
export function useMoonFrames(onDetection?: (detection: LiveMoonDetection) => void) {
  const [liveDetection, setLiveDetection] = useState<LiveMoonDetection | null>(null);
  const lastDetectionDeliveryTime = useRef(0);
  // En una ref para no recrear la salida de fotogramas cada vez que cambia la función.
  const onDetectionRef = useRef(onDetection);
  useEffect(() => {
    onDetectionRef.current = onDetection;
  }, [onDetection]);

  const deliverDetection = useCallback((detection: LiveMoonDetection | null) => {
    const currentTime = Date.now();
    if (currentTime - lastDetectionDeliveryTime.current < 1000 / maximumDetectionsPerSecond) return;
    lastDetectionDeliveryTime.current = currentTime;
    setLiveDetection(detection);
    if (detection) onDetectionRef.current?.(detection);
  }, []);

  const handleFrame = useCallback(
    (frame: Frame) => {
      'worklet';
      const framePixels = readFramePixels(frame);
      if (!framePixels) {
        frame.dispose();
        return;
      }
      const { pixels, bytesPerRow, bytesPerPixel } = framePixels;
      const frameWidth = framePixels.width;
      const frameHeight = framePixels.height;
      const detection = locateBrightObject(pixels, frameWidth, frameHeight, bytesPerRow, bytesPerPixel, detectionSampleStride);
      frame.dispose();
      scheduleOnRN(deliverDetection, detection ? { ...detection, frameWidth, frameHeight } : null);
    },
    [deliverDetection],
  );

  const frameOutput = useFrameOutput({
    // Resolución moderada: solo sirve para localizar la Luna. Así la salida de fotos (12 MP) cabe
    // con ella en la misma sesión de cámara en móviles de gama media.
    targetResolution: CommonResolutions.HD_4_3,
    pixelFormat: 'rgb',
    // Fotogramas ya derechos, como la vista previa y las fotos.
    enablePhysicalBufferRotation: true,
    onFrame: handleFrame,
  });

  return { frameOutput, liveDetection };
}
