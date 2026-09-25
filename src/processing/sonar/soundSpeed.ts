/**
 * Velocidad del sonido en el aire y conversión entre retardo de eco y distancia.
 * Aproximación lineal habitual (aire seco): c ≈ 331,3 + 0,606·T m/s, con T en °C; el error es
 * de ~0,1 % entre −20 y 40 °C, muy por debajo de las demás incertidumbres del sonar.
 */

export function speedOfSoundMetersPerSecond(temperatureCelsius: number): number {
  'worklet';
  return 331.3 + 0.606 * temperatureCelsius;
}

/** Distancia al objeto: el sonido va y vuelve, así que se divide entre dos. */
export function echoDelayToDistanceMeters(echoDelaySeconds: number, temperatureCelsius: number): number {
  'worklet';
  return (echoDelaySeconds * speedOfSoundMetersPerSecond(temperatureCelsius)) / 2;
}

export function distanceToEchoDelaySeconds(distanceMeters: number, temperatureCelsius: number): number {
  'worklet';
  return (2 * distanceMeters) / speedOfSoundMetersPerSecond(temperatureCelsius);
}
