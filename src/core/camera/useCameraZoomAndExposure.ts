import { type RefObject, useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import type { CameraRef, useCameraDevice } from 'react-native-vision-camera';

import { createExposureScale } from './exposureScale';

type CameraDevice = NonNullable<ReturnType<typeof useCameraDevice>>;

function clampNumber(value: number, minimumValue: number, maximumValue: number): number {
  return Math.min(maximumValue, Math.max(minimumValue, value));
}

/**
 * Zoom y compensación de exposición de una `<Camera>`, dentro de los límites del dispositivo.
 * Pasa `zoomFactor` y `exposureBias` como props de la cámara y `handleCameraStarted` a su
 * `onStarted`. `startsDark`: ver `createExposureScale`.
 */
export function useCameraZoomAndExposure(
  cameraRef: RefObject<CameraRef | null>,
  cameraDevice: CameraDevice | undefined,
  startsDark = false,
) {
  const minimumZoom = cameraDevice?.minZoom ?? 1;
  const maximumZoom = cameraDevice?.maxZoom ?? 1;
  const [requestedZoom, setRequestedZoom] = useState(1);
  const zoomFactor = clampNumber(requestedZoom, minimumZoom, maximumZoom);

  const supportsExposureBias = cameraDevice?.supportsExposureBias ?? false;
  const minimumExposureBias = cameraDevice?.minExposureBias ?? 0;
  const maximumExposureBias = cameraDevice?.maxExposureBias ?? 0;
  // En Android la compensación va en pasos enteros de tamaño desconocido; en iOS, en EV.
  const exposureScale = useMemo(
    () => createExposureScale(minimumExposureBias, maximumExposureBias, Platform.OS === 'android', startsDark),
    [minimumExposureBias, maximumExposureBias, startsDark],
  );
  const [requestedExposureBias, setRequestedExposureBias] = useState<number | null>(null);
  const exposureBias = supportsExposureBias
    ? clampNumber(requestedExposureBias ?? exposureScale.initialValue, minimumExposureBias, maximumExposureBias)
    : undefined;

  // Cuenta los arranques de la sesión de cámara para volver a aplicar zoom y exposición.
  const [cameraStartCount, setCameraStartCount] = useState(0);

  // vision-camera envía zoom y exposición en cuanto hay controlador, a menudo antes de que la
  // cámara arranque: Android cancela la orden («Camera is not active») y no se reintenta mientras
  // el valor no cambie. Se reaplican cada vez que la sesión arranca.
  useEffect(() => {
    if (cameraStartCount === 0) return;
    const cameraController = cameraRef.current?.controller;
    if (!cameraController) return;
    cameraController.setZoom(zoomFactor).catch(() => undefined);
    if (exposureBias !== undefined) cameraController.setExposureBias(exposureBias).catch(() => undefined);
  }, [cameraRef, cameraStartCount, zoomFactor, exposureBias]);

  return {
    zoomFactor,
    minimumZoom,
    maximumZoom,
    setRequestedZoom,
    exposureScale,
    /** undefined si el dispositivo no admite compensación de exposición. */
    exposureBias,
    minimumExposureBias,
    maximumExposureBias,
    setRequestedExposureBias,
    handleCameraStarted: () => setCameraStartCount((previousCount) => previousCount + 1),
  };
}
