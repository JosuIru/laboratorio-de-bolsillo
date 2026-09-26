/**
 * «Cámara fijada»: congela el balance de blancos y la exposición para que el color medido sea
 * repetible entre lecturas (y entre la calibración con la tarjeta y la medida).
 *
 * Cuando la zona de referencia está colocada (`isTargetReady`), deja que el automático converja
 * ~1 s, congela el balance de blancos actual (`lockCurrentWhiteBalance`) y pasa a exposición manual
 * (`setExposureLocked`). En Android no se puede leer la exposición del automático, así que se
 * parte de un valor razonable y se ajusta por pasos con el brillo de la zona de referencia
 * (`handleReferenceBrightness`, ver `lockedCameraExposure.ts`) hasta dejarla clara sin saturar.
 * El enfoque se deja en automático: el color medio de una región apenas depende de él, y en
 * Android no se sabe en qué posición está el objetivo para fijarla.
 *
 * Todo se suelta (`resetFocus`) al desactivarlo, al quitar la referencia y al desmontar. Si la
 * cámara se reinicia (`handleCameraStarted`) o se pide «Volver a fijar» (`relock`), empieza de nuevo.
 * Si el móvil no admite fijar nada, la cámara sigue en automático como siempre.
 */
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { CameraController, CameraDevice, CameraRef } from 'react-native-vision-camera';

import {
  advanceExposureSearch,
  type ExposureSearchOutcome,
  type ExposureSearchState,
  type ExposureTargetBand,
  initialManualExposure,
  type ManualExposure,
  planCameraLock,
  type ReferenceBrightnessReading,
  startExposureSearch,
  whiteReferenceTargetBand,
} from './lockedCameraExposure';

/** Tiempo para que el automático converja con la referencia ya delante antes de congelar. */
const automaticConvergenceMilliseconds = 1000;
/**
 * Desde que la cámara confirma la exposición hasta que los fotogramas medidos la reflejan pasan
 * unos cuantos fotogramas: antes no se vuelve a medir.
 */
const exposureSettleMilliseconds = 700;

export type LockedCameraStatus =
  /** El móvil no admite fijar ni el balance ni la exposición: todo en automático. */
  | 'unsupported'
  /** El usuario lo ha desactivado. */
  | 'disabled'
  /** Falta colocar la zona de referencia. */
  | 'waitingForTarget'
  /** Dejando que el automático converja antes de congelar. */
  | 'converging'
  /** Balance congelado; ajustando la exposición manual por pasos. */
  | 'adjustingExposure'
  | 'locked'
  | 'failed';

type LockPhase = 'converging' | 'adjustingExposure' | 'locked' | 'failed';

export interface LockedCameraSettingsOptions {
  cameraRef: RefObject<CameraRef | null>;
  cameraDevice: CameraDevice | undefined;
  /** Interruptor del usuario («Cámara fijada»), activado por defecto. */
  isEnabled: boolean;
  /** La zona de referencia está colocada y se mide. */
  isTargetReady: boolean;
  /** Brillo buscado para la zona de referencia (por defecto, tarjeta blanca o papel). */
  targetBand?: ExposureTargetBand;
  /**
   * Se llama cada vez que cambia la exposición o el balance (y cuando ya se reflejan en los
   * fotogramas): el instrumento debe olvidar sus promedios para no mezclar colores de antes.
   */
  onCameraSettingsChanged?: () => void;
}

export interface LockedCameraSettings {
  status: LockedCameraStatus;
  isSupported: boolean;
  /** Exposición y balance congelados: las lecturas son repetibles. */
  isLocked: boolean;
  /** Ajustando: las lecturas de este momento no valen todavía. */
  isSettling: boolean;
  /** Exposición manual fijada (null si no la hay). */
  lockedExposure: ManualExposure | null;
  isWhiteBalanceLocked: boolean;
  /** La exposición se quedó en el límite del sensor o no se pudo afinar del todo. */
  exposureOutcome: ExposureSearchOutcome | null;
  /** Pásalo al `onStarted` de la cámara: al reiniciarse, la cámara pierde lo fijado. */
  handleCameraStarted: () => void;
  /** Brillo de la zona de referencia en cada lectura nueva de los fotogramas. */
  handleReferenceBrightness: (reading: ReferenceBrightnessReading) => void;
  /** «Volver a fijar»: suelta todo, deja converger el automático y vuelve a congelar. */
  relock: () => void;
}

function isSupersededCameraRequest(requestError: unknown): boolean {
  return /cancel|updated with new options|inactive/i.test(String(requestError));
}

export function useLockedCameraSettings({
  cameraRef,
  cameraDevice,
  isEnabled,
  isTargetReady,
  targetBand = whiteReferenceTargetBand,
  onCameraSettingsChanged,
}: LockedCameraSettingsOptions): LockedCameraSettings {
  // Con lo que dice el dispositivo basta para decidir si se ofrece; los rangos de exposición se
  // leen del controlador al fijar (en Android solo se conocen con la cámara arrancada).
  const isSupported = Boolean(cameraDevice?.supportsWhiteBalanceLocking || cameraDevice?.supportsExposureLocking);
  const shouldLock = isSupported && isEnabled && isTargetReady;

  const [lockCycle, setLockCycle] = useState(0);
  const [lockPhase, setLockPhase] = useState<LockPhase>('converging');
  const [lockedExposure, setLockedExposure] = useState<ManualExposure | null>(null);
  const [isWhiteBalanceLocked, setIsWhiteBalanceLocked] = useState(false);
  const [exposureOutcome, setExposureOutcome] = useState<ExposureSearchOutcome | null>(null);

  // Cada petición de fijar (activar, colocar la referencia, «Volver a fijar», reinicio de la
  // cámara) empieza de cero.
  const lockRequestKey = shouldLock ? `lock-${lockCycle}` : 'released';
  const [trackedLockRequestKey, setTrackedLockRequestKey] = useState(lockRequestKey);
  if (trackedLockRequestKey !== lockRequestKey) {
    setTrackedLockRequestKey(lockRequestKey);
    setLockPhase('converging');
    setLockedExposure(null);
    setIsWhiteBalanceLocked(false);
    setExposureOutcome(null);
  }

  const onCameraSettingsChangedRef = useRef(onCameraSettingsChanged);
  const targetBandRef = useRef(targetBand);
  useEffect(() => {
    onCameraSettingsChangedRef.current = onCameraSettingsChanged;
    targetBandRef.current = targetBand;
  });

  /** Identifica el ciclo de fijado en curso: las respuestas de ciclos anteriores se ignoran. */
  const activeCycleToken = useRef(0);
  const lockedController = useRef<CameraController | null>(null);
  const exposureSearch = useRef<ExposureSearchState | null>(null);
  const exposureLimits = useRef<ReturnType<typeof planCameraLock>['exposureLimits']>(null);
  /** Desde cuándo valen las lecturas de brillo (null: hay una exposición pendiente). */
  const readingsAcceptedAfter = useRef<number | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasLockedWhiteBalance = useRef(false);

  const applyManualExposure = useCallback((cycleToken: number, exposure: ManualExposure) => {
    const cameraController = lockedController.current;
    if (!cameraController) return;
    readingsAcceptedAfter.current = null;
    cameraController
      .setExposureLocked(exposure.durationSeconds, exposure.iso)
      .then(() => {
        if (activeCycleToken.current !== cycleToken) return;
        // La que de verdad ha aplicado el sensor (ajustada a sus rangos), si la dice.
        setLockedExposure({
          durationSeconds: cameraController.exposureDuration || exposure.durationSeconds,
          iso: cameraController.iso || exposure.iso,
        });
        if (settleTimer.current) clearTimeout(settleTimer.current);
        settleTimer.current = setTimeout(() => {
          if (activeCycleToken.current !== cycleToken) return;
          onCameraSettingsChangedRef.current?.();
          readingsAcceptedAfter.current = Date.now();
          // Si era la exposición final de la búsqueda, ya está todo fijado.
          const finishedOutcome = exposureSearch.current?.outcome;
          if (finishedOutcome && finishedOutcome !== 'adjusting') {
            setExposureOutcome(finishedOutcome);
            setLockPhase('locked');
          }
        }, exposureSettleMilliseconds);
      })
      .catch((requestError: unknown) => {
        if (activeCycleToken.current !== cycleToken || isSupersededCameraRequest(requestError)) return;
        // El móvil no acepta la exposición manual: se deja el automático (con el balance fijado,
        // si se pudo).
        exposureSearch.current = null;
        setLockedExposure(null);
        setExposureOutcome(null);
        setLockPhase(hasLockedWhiteBalance.current ? 'locked' : 'failed');
        onCameraSettingsChangedRef.current?.();
      });
  }, []);

  useEffect(() => {
    if (!shouldLock) return;
    const cycleToken = activeCycleToken.current + 1;
    activeCycleToken.current = cycleToken;
    /** Ya se ha empezado a tocar la cámara: al soltar hay que devolverla al automático. */
    let hasStartedLocking = false;
    hasLockedWhiteBalance.current = false;

    const convergenceTimer = setTimeout(() => {
      void (async () => {
        const cameraController = cameraRef.current?.controller;
        if (activeCycleToken.current !== cycleToken) return;
        if (!cameraController) {
          setLockPhase('failed');
          return;
        }
        lockedController.current = cameraController;
        hasStartedLocking = true;
        const lockPlan = planCameraLock({
          supportsExposureLocking: cameraController.device.supportsExposureLocking,
          supportsWhiteBalanceLocking: cameraController.device.supportsWhiteBalanceLocking,
          minimumDurationSeconds: cameraController.minExposureDuration,
          maximumDurationSeconds: cameraController.maxExposureDuration,
          minimumIso: cameraController.minISO,
          maximumIso: cameraController.maxISO,
        });
        let didLockWhiteBalance = false;
        if (lockPlan.canLockWhiteBalance) {
          try {
            await cameraController.lockCurrentWhiteBalance();
            didLockWhiteBalance = true;
          } catch {
            // Sin balance fijo: se sigue con la exposición si se puede.
          }
        }
        if (activeCycleToken.current !== cycleToken) return;
        hasLockedWhiteBalance.current = didLockWhiteBalance;
        setIsWhiteBalanceLocked(didLockWhiteBalance);
        exposureLimits.current = lockPlan.exposureLimits;
        if (!lockPlan.exposureLimits) {
          onCameraSettingsChangedRef.current?.();
          setLockPhase(didLockWhiteBalance ? 'locked' : 'failed');
          return;
        }
        const reportedExposure = { durationSeconds: cameraController.exposureDuration, iso: cameraController.iso };
        const startingExposure = initialManualExposure(reportedExposure, lockPlan.exposureLimits);
        exposureSearch.current = startExposureSearch(startingExposure);
        setLockPhase('adjustingExposure');
        applyManualExposure(cycleToken, startingExposure);
      })();
    }, automaticConvergenceMilliseconds);

    return () => {
      clearTimeout(convergenceTimer);
      if (settleTimer.current) clearTimeout(settleTimer.current);
      // Invalida las respuestas pendientes de este ciclo.
      activeCycleToken.current = cycleToken + 1;
      exposureSearch.current = null;
      readingsAcceptedAfter.current = null;
      const cameraController = lockedController.current;
      lockedController.current = null;
      if (hasStartedLocking && cameraController) {
        // Vuelve a la exposición, el balance y el enfoque automáticos (la cámara puede estar ya
        // cerrada al desmontar: no pasa nada, el siguiente controlador empieza sin nada fijado).
        try {
          cameraController.resetFocus().catch(() => undefined);
        } catch {
          // Controlador ya liberado.
        }
        onCameraSettingsChangedRef.current?.();
      }
    };
  }, [shouldLock, lockCycle, cameraRef, applyManualExposure]);

  const handleReferenceBrightness = useCallback(
    (reading: ReferenceBrightnessReading) => {
      const searchState = exposureSearch.current;
      const limits = exposureLimits.current;
      const acceptedAfter = readingsAcceptedAfter.current;
      if (!searchState || !limits || searchState.outcome !== 'adjusting') return;
      if (acceptedAfter === null || Date.now() < acceptedAfter) return;
      const nextSearchState = advanceExposureSearch(searchState, reading, limits, targetBandRef.current);
      exposureSearch.current = nextSearchState;
      const hasExposureChanged =
        nextSearchState.exposure.durationSeconds !== searchState.exposure.durationSeconds ||
        nextSearchState.exposure.iso !== searchState.exposure.iso;
      if (hasExposureChanged) {
        // Si la búsqueda ha terminado, queda fijada cuando esta última exposición se asiente.
        applyManualExposure(activeCycleToken.current, nextSearchState.exposure);
      } else if (nextSearchState.outcome !== 'adjusting') {
        setExposureOutcome(nextSearchState.outcome);
        setLockPhase('locked');
      }
    },
    [applyManualExposure],
  );

  const relock = useCallback(() => setLockCycle((previousCycle) => previousCycle + 1), []);

  let status: LockedCameraStatus;
  if (!isSupported) status = 'unsupported';
  else if (!isEnabled) status = 'disabled';
  else if (!isTargetReady) status = 'waitingForTarget';
  else status = lockPhase;

  return {
    status,
    isSupported,
    isLocked: status === 'locked',
    isSettling: status === 'converging' || status === 'adjustingExposure',
    lockedExposure: shouldLock ? lockedExposure : null,
    isWhiteBalanceLocked: shouldLock && isWhiteBalanceLocked,
    exposureOutcome: shouldLock ? exposureOutcome : null,
    handleCameraStarted: relock,
    handleReferenceBrightness,
    relock,
  };
}
