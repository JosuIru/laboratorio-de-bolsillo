import type { TiltAngles } from '@/processing/signal/orientation';

/**
 * Geometría de la nivelación de autocaravanas y caravanas. Sin React ni React Native.
 *
 * El móvil va plano sobre el suelo del vehículo con su parte superior hacia delante, así que su
 * eje X apunta al lado derecho del vehículo y su eje Y hacia el morro. Con el convenio de
 * `tiltAnglesFromGravity` (reacción a la gravedad, +g hacia arriba), una inclinación X positiva
 * significa que el lado derecho está más alto, y una Y positiva, que el morro está más alto.
 */

export type VehicleLayout = 'fourWheels' | 'singleAxle';

export interface VehicleTilt {
  /** Positivo: el lado derecho está más alto que el izquierdo. */
  lateralTiltDegrees: number;
  /** Positivo: el morro está más alto que la trasera. */
  longitudinalTiltDegrees: number;
}

/** Cuántos cm hay que levantar cada rueda de un vehículo de dos ejes. */
export interface FourWheelLifts {
  frontLeftLiftCentimeters: number;
  frontRightLiftCentimeters: number;
  rearLeftLiftCentimeters: number;
  rearRightLiftCentimeters: number;
  /** Subida media del eje delantero (la de su punto central). */
  frontAxleLiftCentimeters: number;
  /** Subida media del eje trasero (la de su punto central). */
  rearAxleLiftCentimeters: number;
}

/** Nivelación de una caravana de un eje: calzo lateral y ajuste de la rueda jockey. */
export interface SingleAxleLeveling {
  leftWheelLiftCentimeters: number;
  rightWheelLiftCentimeters: number;
  /** Positivo: subir el morro con la rueda jockey; negativo: bajarlo. */
  jockeyWheelChangeCentimeters: number;
}

/** Por debajo de este ángulo en los dos ejes se da el vehículo por nivelado. */
export const levelToleranceDegrees = 0.3;

const radiansPerDegree = Math.PI / 180;

export function vehicleTiltFromPhoneTilt(phoneTilt: TiltAngles): VehicleTilt {
  return { lateralTiltDegrees: phoneTilt.tiltXDegrees, longitudinalTiltDegrees: phoneTilt.tiltYDegrees };
}

/**
 * Altura de un punto del suelo del vehículo respecto al centro de referencia. `rightwardCentimeters`
 * y `forwardCentimeters` se miden sobre el propio suelo (inclinado), por eso se usa el seno: los
 * ángulos de `tiltAnglesFromGravity` son asin(g_eje / |g|) y la altura es la proyección exacta.
 */
function pointHeightCentimeters(vehicleTilt: VehicleTilt, rightwardCentimeters: number, forwardCentimeters: number) {
  return (
    rightwardCentimeters * Math.sin(vehicleTilt.lateralTiltDegrees * radiansPerDegree) +
    forwardCentimeters * Math.sin(vehicleTilt.longitudinalTiltDegrees * radiansPerDegree)
  );
}

/**
 * Calzos para un vehículo de dos ejes sin bajar ninguna rueda: la rueda más alta se queda en 0 y
 * las demás suben hasta su altura. Como las cuatro ruedas apoyan en el mismo plano, al igualar sus
 * alturas el suelo queda horizontal.
 */
export function computeFourWheelLifts(
  vehicleTilt: VehicleTilt,
  trackWidthCentimeters: number,
  wheelbaseCentimeters: number,
): FourWheelLifts {
  const halfTrack = trackWidthCentimeters / 2;
  const halfWheelbase = wheelbaseCentimeters / 2;
  const frontLeftHeight = pointHeightCentimeters(vehicleTilt, -halfTrack, halfWheelbase);
  const frontRightHeight = pointHeightCentimeters(vehicleTilt, halfTrack, halfWheelbase);
  const rearLeftHeight = pointHeightCentimeters(vehicleTilt, -halfTrack, -halfWheelbase);
  const rearRightHeight = pointHeightCentimeters(vehicleTilt, halfTrack, -halfWheelbase);
  const highestWheelHeight = Math.max(frontLeftHeight, frontRightHeight, rearLeftHeight, rearRightHeight);

  const frontLeftLiftCentimeters = highestWheelHeight - frontLeftHeight;
  const frontRightLiftCentimeters = highestWheelHeight - frontRightHeight;
  const rearLeftLiftCentimeters = highestWheelHeight - rearLeftHeight;
  const rearRightLiftCentimeters = highestWheelHeight - rearRightHeight;
  return {
    frontLeftLiftCentimeters,
    frontRightLiftCentimeters,
    rearLeftLiftCentimeters,
    rearRightLiftCentimeters,
    frontAxleLiftCentimeters: (frontLeftLiftCentimeters + frontRightLiftCentimeters) / 2,
    rearAxleLiftCentimeters: (rearLeftLiftCentimeters + rearRightLiftCentimeters) / 2,
  };
}

/**
 * Caravana de un eje: se calza la rueda del lado bajo y luego se ajusta la rueda jockey, que está
 * a `jockeyDistanceCentimeters` por delante del eje. El ajuste del morro tiene en cuenta que calzar
 * una rueda sube también el centro del eje (la mitad del calzo).
 */
export function computeSingleAxleLeveling(
  vehicleTilt: VehicleTilt,
  trackWidthCentimeters: number,
  jockeyDistanceCentimeters: number,
): SingleAxleLeveling {
  const halfTrack = trackWidthCentimeters / 2;
  const leftWheelHeight = pointHeightCentimeters(vehicleTilt, -halfTrack, 0);
  const rightWheelHeight = pointHeightCentimeters(vehicleTilt, halfTrack, 0);
  const jockeyWheelHeight = pointHeightCentimeters(vehicleTilt, 0, jockeyDistanceCentimeters);
  const leveledAxleHeight = Math.max(leftWheelHeight, rightWheelHeight);
  return {
    leftWheelLiftCentimeters: leveledAxleHeight - leftWheelHeight,
    rightWheelLiftCentimeters: leveledAxleHeight - rightWheelHeight,
    jockeyWheelChangeCentimeters: leveledAxleHeight - jockeyWheelHeight,
  };
}

/** Nivelado cuando ninguno de los dos ángulos pasa de la tolerancia. */
export function isVehicleLevel(vehicleTilt: VehicleTilt, toleranceDegrees = levelToleranceDegrees): boolean {
  return (
    Math.abs(vehicleTilt.lateralTiltDegrees) < toleranceDegrees &&
    Math.abs(vehicleTilt.longitudinalTiltDegrees) < toleranceDegrees
  );
}

/**
 * Método de inversión: la primera lectura es inclinación del suelo + desfase del móvil; tras girar
 * el móvil 180° en el mismo sitio, la inclinación del suelo cambia de signo y el desfase no. La
 * media de las dos lecturas es el desfase del móvil (el cero que hay que restar).
 */
export function zeroOffsetFromInversion(firstReading: TiltAngles, rotatedReading: TiltAngles): TiltAngles {
  return {
    tiltXDegrees: (firstReading.tiltXDegrees + rotatedReading.tiltXDegrees) / 2,
    tiltYDegrees: (firstReading.tiltYDegrees + rotatedReading.tiltYDegrees) / 2,
  };
}

export function applyZeroOffset(rawTilt: TiltAngles, zeroOffset: TiltAngles): TiltAngles {
  return {
    tiltXDegrees: rawTilt.tiltXDegrees - zeroOffset.tiltXDegrees,
    tiltYDegrees: rawTilt.tiltYDegrees - zeroOffset.tiltYDegrees,
  };
}
