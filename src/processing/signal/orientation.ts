export interface GravityVector {
  x: number;
  y: number;
  z: number;
}

export interface TiltAngles {
  /** Giro alrededor del eje Y del móvil (izquierda/derecha), en grados. */
  tiltXDegrees: number;
  /** Giro alrededor del eje X del móvil (arriba/abajo), en grados. */
  tiltYDegrees: number;
}

const degreesPerRadian = 180 / Math.PI;

/**
 * Inclinación respecto a la horizontal a partir del vector de gravedad (acelerómetro en reposo).
 * Con el móvil boca arriba sobre una mesa plana, ambos ángulos son 0.
 */
export function tiltAnglesFromGravity(gravity: GravityVector): TiltAngles {
  'worklet';
  return {
    tiltXDegrees: Math.atan2(gravity.x, Math.hypot(gravity.y, gravity.z)) * degreesPerRadian,
    tiltYDegrees: Math.atan2(gravity.y, Math.hypot(gravity.x, gravity.z)) * degreesPerRadian,
  };
}
