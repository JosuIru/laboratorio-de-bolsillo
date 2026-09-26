/**
 * Guía para apuntar la cámara trasera a un astro con el acelerómetro y el magnetómetro.
 *
 * Ejes del móvil (convención de Android): x hacia la derecha de la pantalla, y hacia arriba de la
 * pantalla, z saliendo de la pantalla hacia el usuario. La cámara trasera mira hacia -z.
 * Módulo puro: sin React ni React Native.
 */

export interface DeviceVector {
  x: number;
  y: number;
  z: number;
}

const radiansToDegrees = 180 / Math.PI;
const degreesToRadians = Math.PI / 180;

function crossProduct(first: DeviceVector, second: DeviceVector): DeviceVector {
  return {
    x: first.y * second.z - first.z * second.y,
    y: first.z * second.x - first.x * second.z,
    z: first.x * second.y - first.y * second.x,
  };
}

function normalizeVector(vector: DeviceVector): DeviceVector | null {
  const vectorLength = Math.hypot(vector.x, vector.y, vector.z);
  if (vectorLength < 1e-9) return null;
  return { x: vector.x / vectorLength, y: vector.y / vectorLength, z: vector.z / vectorLength };
}

/** Direcciones este, norte y arriba del mundo, expresadas en ejes del móvil. */
export interface WorldAxesInDevice {
  east: DeviceVector;
  north: DeviceVector;
  up: DeviceVector;
}

/**
 * Orientación del móvil a partir de la aceleración en reposo (apunta hacia arriba: es la reacción
 * a la gravedad) y del campo magnético. Devuelve `null` si los vectores son casi paralelos
 * (móvil junto a un imán, o medidas nulas).
 */
export function worldAxesFromSensors(upwardAcceleration: DeviceVector, magneticField: DeviceVector): WorldAxesInDevice | null {
  const up = normalizeVector(upwardAcceleration);
  if (!up) return null;
  // El campo apunta al norte magnético (y hacia abajo en el hemisferio norte): campo × arriba = este.
  const east = normalizeVector(crossProduct(magneticField, up));
  if (!east) return null;
  return { east, north: crossProduct(up, east), up };
}

export interface CameraPointing {
  /** Acimut hacia el que mira la cámara trasera, desde el norte magnético hacia el este [0, 360). */
  azimuthDegrees: number;
  /** Altura sobre el horizonte hacia la que mira la cámara trasera. */
  elevationDegrees: number;
}

/** Hacia dónde mira la cámara trasera (eje -z del móvil). */
export function cameraPointingFromAxes(worldAxes: WorldAxesInDevice): CameraPointing {
  const azimuthDegrees = Math.atan2(-worldAxes.east.z, -worldAxes.north.z) * radiansToDegrees;
  return {
    azimuthDegrees: azimuthDegrees < 0 ? azimuthDegrees + 360 : azimuthDegrees,
    elevationDegrees: Math.asin(Math.max(-1, Math.min(1, -worldAxes.up.z))) * radiansToDegrees,
  };
}

export interface PointingGuidance {
  /** Ángulo entre el centro de la cámara y el astro, en grados. */
  angularDistanceDegrees: number;
  /**
   * Dirección de la flecha en la pantalla hacia el astro, en grados: 0 = derecha, 90 = arriba
   * (sentido antihorario, como en matemáticas).
   */
  screenArrowAngleDegrees: number;
  /** Giro horizontal necesario (positivo = a la derecha), en grados (-180, 180]. */
  turnRightDegrees: number;
  /** Cuánto subir (positivo) o bajar la cámara, en grados. */
  raiseDegrees: number;
}

/**
 * Cómo mover el móvil para centrar un astro en la cámara trasera. La flecha tiene en cuenta
 * cómo está girado el móvil: señala en la pantalla hacia donde queda el astro.
 */
export function computePointingGuidance(
  worldAxes: WorldAxesInDevice,
  targetAzimuthDegrees: number,
  targetAltitudeDegrees: number,
): PointingGuidance {
  const targetEast = Math.cos(targetAltitudeDegrees * degreesToRadians) * Math.sin(targetAzimuthDegrees * degreesToRadians);
  const targetNorth = Math.cos(targetAltitudeDegrees * degreesToRadians) * Math.cos(targetAzimuthDegrees * degreesToRadians);
  const targetUp = Math.sin(targetAltitudeDegrees * degreesToRadians);
  const { east, north, up } = worldAxes;
  const targetInDevice = {
    x: targetEast * east.x + targetNorth * north.x + targetUp * up.x,
    y: targetEast * east.y + targetNorth * north.y + targetUp * up.y,
    z: targetEast * east.z + targetNorth * north.z + targetUp * up.z,
  };
  const cameraPointing = cameraPointingFromAxes(worldAxes);
  let turnRightDegrees = (targetAzimuthDegrees - cameraPointing.azimuthDegrees) % 360;
  if (turnRightDegrees > 180) turnRightDegrees -= 360;
  if (turnRightDegrees <= -180) turnRightDegrees += 360;
  return {
    angularDistanceDegrees: Math.acos(Math.max(-1, Math.min(1, -targetInDevice.z))) * radiansToDegrees,
    screenArrowAngleDegrees: Math.atan2(targetInDevice.y, targetInDevice.x) * radiansToDegrees,
    turnRightDegrees,
    raiseDegrees: targetAltitudeDegrees - cameraPointing.elevationDegrees,
  };
}

/** Filtro exponencial por componentes para suavizar las lecturas de los sensores. */
export function smoothVector(previous: DeviceVector | null, sample: DeviceVector, smoothingFactor: number): DeviceVector {
  if (!previous) return sample;
  return {
    x: previous.x + smoothingFactor * (sample.x - previous.x),
    y: previous.y + smoothingFactor * (sample.y - previous.y),
    z: previous.z + smoothingFactor * (sample.z - previous.z),
  };
}

/**
 * Declinación magnética (grados, positiva si el norte magnético está al este del geográfico) a
 * partir de un rumbo del sistema que da los dos nortes. `null` si falta el geográfico (el
 * sistema da −1 sin permiso de ubicación).
 */
export function magneticDeclinationFromHeadings(trueHeadingDegrees: number, magneticHeadingDegrees: number): number | null {
  if (!Number.isFinite(trueHeadingDegrees) || trueHeadingDegrees < 0 || !Number.isFinite(magneticHeadingDegrees)) return null;
  const declinationDegrees = (((trueHeadingDegrees - magneticHeadingDegrees) % 360) + 540) % 360 - 180;
  return declinationDegrees;
}

/**
 * Pasa un acimut geográfico (el de las efemérides) a magnético (el de la brújula del móvil).
 * En España la diferencia es de ~1°, pero en otros lugares llega a 10-20°.
 */
export function trueToMagneticAzimuth(trueAzimuthDegrees: number, magneticDeclinationDegrees: number): number {
  const magneticAzimuthDegrees = (trueAzimuthDegrees - magneticDeclinationDegrees) % 360;
  return magneticAzimuthDegrees < 0 ? magneticAzimuthDegrees + 360 : magneticAzimuthDegrees;
}
