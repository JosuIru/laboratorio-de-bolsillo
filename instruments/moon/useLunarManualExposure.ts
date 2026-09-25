import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { CameraRef, useCameraDevice } from 'react-native-vision-camera';

import {
  clampExposureDuration,
  type ExposureDurationRange,
  exposureThirdStopFactor,
  initialLunarExposureSeconds,
  type LunarBrightnessReading,
  nextLunarExposureSeconds,
} from '@/processing/image/lunarExposure';

type CameraDevice = NonNullable<ReturnType<typeof useCameraDevice>>;

/**
 * Desde que la cámara confirma la nueva exposición hasta que las detecciones la reflejan pasan
 * unos cuantos fotogramas (las detecciones llegan a 4/s): no se reajusta antes.
 */
const settleMillisecondsAfterExposureApplied = 700;

/**
 * CameraX rechaza la petición anterior cuando llega otra («updated with new options») o cuando la
 * cámara se para («inactive»). No son fallos de la exposición manual: la última petición manda.
 */
function isSupersededCameraRequest(requestError: unknown): boolean {
  return /cancel|updated with new options|inactive/i.test(String(requestError));
}

interface ManualExposureLimits {
  durationRange: ExposureDurationRange;
  /** ISO fijo: el más bajo, el de menos ruido. La Luna tiene luz de sobra. */
  iso: number;
}

/**
 * Exposición manual (tiempo e ISO fijos, sin exposición automática) para la Luna.
 *
 * En modo automático, `handleBrightnessReading` ajusta el tiempo con cada detección para que la
 * Luna quede lo más clara posible sin quemarse. Los botones pasan a modo manual. Pasa
 * `handleCameraStarted` al `onStarted` de la cámara. Mientras `isFrozen` (durante la captura), la
 * exposición no cambia.
 */
export function useLunarManualExposure(
  cameraRef: RefObject<CameraRef | null>,
  cameraDevice: CameraDevice | undefined,
  isFrozen: boolean,
) {
  const supportsExposureLocking = cameraDevice?.supportsExposureLocking ?? false;
  const [manualExposureLimits, setManualExposureLimits] = useState<ManualExposureLimits | null>(null);
  const [hasManualExposureFailed, setHasManualExposureFailed] = useState(false);
  const [exposureSeconds, setExposureSeconds] = useState(initialLunarExposureSeconds);
  const [isAutomatic, setIsAutomatic] = useState(true);
  // Cuenta los arranques de la cámara y las peticiones de reaplicar, para volver a fijar la exposición.
  const [applyRequestCount, setApplyRequestCount] = useState(0);
  /** Momento en que la cámara confirmó la última exposición; null mientras hay una pendiente. */
  const exposureAppliedTime = useRef<number | null>(null);

  const isManualExposureActive = manualExposureLimits !== null && !hasManualExposureFailed;

  // Los límites del sensor solo se conocen cuando la cámara ha arrancado.
  const handleCameraStarted = useCallback(() => {
    const cameraController = cameraRef.current?.controller;
    if (supportsExposureLocking && cameraController && cameraController.maxExposureDuration > 0) {
      const durationRange = {
        minimumSeconds: cameraController.minExposureDuration,
        maximumSeconds: cameraController.maxExposureDuration,
      };
      setManualExposureLimits({ durationRange, iso: cameraController.minISO });
      setExposureSeconds((previousSeconds) => clampExposureDuration(previousSeconds, durationRange));
    }
    setApplyRequestCount((previousCount) => previousCount + 1);
  }, [cameraRef, supportsExposureLocking]);

  useEffect(() => {
    if (!isManualExposureActive || !manualExposureLimits) return;
    const cameraController = cameraRef.current?.controller;
    if (!cameraController) return;
    exposureAppliedTime.current = null;
    cameraController
      .setExposureLocked(exposureSeconds, manualExposureLimits.iso)
      .then(() => {
        exposureAppliedTime.current = Date.now();
      })
      .catch((requestError: unknown) => {
        if (isSupersededCameraRequest(requestError)) return;
        // El móvil no la acepta: se vuelve de verdad a la exposición automática y a la compensación.
        setHasManualExposureFailed(true);
        cameraRef.current?.resetFocus().catch(() => undefined);
      });
  }, [cameraRef, applyRequestCount, isManualExposureActive, manualExposureLimits, exposureSeconds]);

  const handleBrightnessReading = useCallback(
    (brightnessReading: LunarBrightnessReading) => {
      if (!isAutomatic || isFrozen || !isManualExposureActive || !manualExposureLimits) return;
      const appliedTime = exposureAppliedTime.current;
      if (appliedTime === null || Date.now() - appliedTime < settleMillisecondsAfterExposureApplied) return;
      const nextExposureSeconds = nextLunarExposureSeconds(
        exposureSeconds,
        brightnessReading,
        manualExposureLimits.durationRange,
      );
      if (nextExposureSeconds === exposureSeconds) return;
      exposureAppliedTime.current = null;
      setExposureSeconds(nextExposureSeconds);
    },
    [isAutomatic, isFrozen, isManualExposureActive, manualExposureLimits, exposureSeconds],
  );

  function stepExposureByThirds(direction: 1 | -1) {
    if (!manualExposureLimits) return;
    setIsAutomatic(false);
    setExposureSeconds(
      clampExposureDuration(exposureSeconds * exposureThirdStopFactor ** direction, manualExposureLimits.durationRange),
    );
  }

  return {
    /** false: el móvil no admite exposición manual; hay que usar la compensación. */
    isManualExposureActive,
    exposureSeconds,
    iso: manualExposureLimits?.iso ?? 0,
    isAutomatic,
    isAtShortestExposure: manualExposureLimits
      ? exposureSeconds <= manualExposureLimits.durationRange.minimumSeconds
      : false,
    isAtLongestExposure: manualExposureLimits
      ? exposureSeconds >= manualExposureLimits.durationRange.maximumSeconds
      : false,
    handleCameraStarted,
    handleBrightnessReading,
    darken: () => stepExposureByThirds(-1),
    brighten: () => stepExposureByThirds(1),
    enableAutomatic: () => setIsAutomatic(true),
    /** Vuelve a fijar la exposición manual (p. ej. después de `resetFocus`, que la quita). */
    reapplyExposure: () => setApplyRequestCount((previousCount) => previousCount + 1),
  };
}
