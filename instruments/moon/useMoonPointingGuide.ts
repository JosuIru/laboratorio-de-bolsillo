import * as Location from 'expo-location';
import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { accelerometerSource, magnetometerSource } from '@/core/sensors/adapters/motionAndEnvironment';
import type { Vector3 } from '@/core/sensors/types';
import { useSensorSubscription } from '@/core/sensors/useSensorSubscription';
import type { HorizontalPosition } from '@/processing/astronomy/moonEphemeris';
import {
  computePointingGuidance,
  type DeviceVector,
  magneticDeclinationFromHeadings,
  type PointingGuidance,
  smoothVector,
  trueToMagneticAzimuth,
  worldAxesFromSensors,
} from '@/processing/astronomy/pointingGuide';

const sensorRateHz = 20;
/** Suavizado de las lecturas: más bajo = flecha más estable pero más lenta. */
const sensorSmoothingFactor = 0.15;
/** Actualizaciones de la flecha por segundo. */
const maximumGuidanceUpdatesPerSecond = 10;

/**
 * Guía en tiempo real para apuntar la cámara trasera a la Luna. Devuelve `null` hasta tener
 * lecturas de los dos sensores (o si no se conoce la posición de la Luna).
 */
export function useMoonPointingGuide(moonPosition: HorizontalPosition | undefined, isActive: boolean) {
  const smoothedAcceleration = useRef<DeviceVector | null>(null);
  const smoothedMagneticField = useRef<DeviceVector | null>(null);
  const lastGuidanceUpdateTime = useRef(0);
  const [pointingGuidance, setPointingGuidance] = useState<PointingGuidance | null>(null);
  const isGuideActive = isActive && moonPosition !== undefined;
  /** Diferencia entre el norte geográfico y el magnético aquí; 0 hasta que el sistema la dé. */
  const magneticDeclinationDegrees = useRef(0);

  // La brújula del móvil mide desde el norte magnético y las efemérides dan el acimut desde el
  // geográfico. El sistema calcula la declinación del lugar (necesita permiso de ubicación).
  useEffect(() => {
    if (!isGuideActive) return;
    let headingSubscription: Location.LocationSubscription | null = null;
    let isEffectActive = true;
    Location.watchHeadingAsync((heading) => {
      const declinationDegrees = magneticDeclinationFromHeadings(heading.trueHeading, heading.magHeading);
      if (declinationDegrees !== null) magneticDeclinationDegrees.current = declinationDegrees;
    })
      .then((subscription) => {
        if (isEffectActive) headingSubscription = subscription;
        else subscription.remove();
      })
      .catch(() => undefined);
    return () => {
      isEffectActive = false;
      headingSubscription?.remove();
    };
  }, [isGuideActive]);

  function updateGuidance() {
    const currentTime = Date.now();
    if (currentTime - lastGuidanceUpdateTime.current < 1000 / maximumGuidanceUpdatesPerSecond) return;
    if (!moonPosition || !smoothedAcceleration.current || !smoothedMagneticField.current) return;
    const worldAxes = worldAxesFromSensors(smoothedAcceleration.current, smoothedMagneticField.current);
    if (!worldAxes) return;
    lastGuidanceUpdateTime.current = currentTime;
    const moonMagneticAzimuthDegrees = trueToMagneticAzimuth(moonPosition.azimuthDegrees, magneticDeclinationDegrees.current);
    setPointingGuidance(computePointingGuidance(worldAxes, moonMagneticAzimuthDegrees, moonPosition.altitudeDegrees));
  }

  useSensorSubscription(
    accelerometerSource,
    (sample: { value: Vector3 }) => {
      // Android da la reacción a la gravedad (hacia arriba); iOS, la gravedad (hacia abajo).
      const upwardSign = Platform.OS === 'ios' ? -1 : 1;
      const upwardAcceleration = {
        x: upwardSign * sample.value.x,
        y: upwardSign * sample.value.y,
        z: upwardSign * sample.value.z,
      };
      smoothedAcceleration.current = smoothVector(smoothedAcceleration.current, upwardAcceleration, sensorSmoothingFactor);
      updateGuidance();
    },
    { isActive: isGuideActive, targetRateHz: sensorRateHz },
  );

  useSensorSubscription(
    magnetometerSource,
    (sample: { value: Vector3 }) => {
      smoothedMagneticField.current = smoothVector(smoothedMagneticField.current, sample.value, sensorSmoothingFactor);
      updateGuidance();
    },
    { isActive: isGuideActive, targetRateHz: sensorRateHz },
  );

  return isGuideActive ? pointingGuidance : null;
}
