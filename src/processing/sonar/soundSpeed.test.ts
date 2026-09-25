import { distanceToEchoDelaySeconds, echoDelayToDistanceMeters, speedOfSoundMetersPerSecond } from './soundSpeed';

describe('velocidad del sonido', () => {
  it('sigue 331,3 + 0,606·T', () => {
    expect(speedOfSoundMetersPerSecond(0)).toBeCloseTo(331.3);
    expect(speedOfSoundMetersPerSecond(20)).toBeCloseTo(343.42);
    expect(speedOfSoundMetersPerSecond(-10)).toBeCloseTo(325.24);
  });

  it('convierte el retardo de ida y vuelta en distancia según la temperatura', () => {
    // 5,824 ms a 20 °C son 1 m (ida y vuelta: 2 m).
    expect(echoDelayToDistanceMeters(2 / 343.42, 20)).toBeCloseTo(1, 6);
    // El mismo retardo a 0 °C da una distancia un 3,5 % menor.
    expect(echoDelayToDistanceMeters(2 / 343.42, 0)).toBeCloseTo(331.3 / 343.42, 6);
    expect(distanceToEchoDelaySeconds(1.5, 30)).toBeCloseTo(3 / (331.3 + 0.606 * 30), 9);
    expect(echoDelayToDistanceMeters(distanceToEchoDelaySeconds(2.7, 12), 12)).toBeCloseTo(2.7, 9);
  });
});
