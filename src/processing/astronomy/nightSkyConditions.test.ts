import { assessNightSky, moonInterferenceFor, skyDarknessForSunAltitude } from './nightSkyConditions';

const bilbao = { latitudeDegrees: 43.26, longitudeDegrees: -2.93 };

describe('condiciones del cielo', () => {
  it('clasifica la oscuridad por la altura del Sol', () => {
    expect(skyDarknessForSunAltitude(10)).toBe('day');
    expect(skyDarknessForSunAltitude(-3)).toBe('civilTwilight');
    expect(skyDarknessForSunAltitude(-9)).toBe('nauticalTwilight');
    expect(skyDarknessForSunAltitude(-15)).toBe('astronomicalTwilight');
    expect(skyDarknessForSunAltitude(-30)).toBe('night');
  });

  it('la Luna bajo el horizonte no estorba; llena y alta, mucho', () => {
    expect(moonInterferenceFor(1, -10)).toBe('none');
    expect(moonInterferenceFor(0.1, 30)).toBe('low');
    expect(moonInterferenceFor(0.5, 30)).toBe('moderate');
    expect(moonInterferenceFor(0.98, 30)).toBe('strong');
    expect(moonInterferenceFor(0.98, null)).toBe('strong');
  });

  it('medianoche de invierno en Bilbao: noche cerrada', () => {
    const conditions = assessNightSky(new Date(Date.UTC(2024, 11, 21, 0, 0)), bilbao);
    expect(conditions.sunAltitudeDegrees!).toBeLessThan(-60);
    expect(conditions.darkness).toBe('night');
  });

  it('mediodía de verano en Bilbao: de día; sin ubicación no hay alturas', () => {
    const noonConditions = assessNightSky(new Date(Date.UTC(2024, 5, 21, 12, 15)), bilbao);
    expect(noonConditions.sunAltitudeDegrees!).toBeGreaterThan(65);
    expect(noonConditions.darkness).toBe('day');
    // Luna llena el 24 de abril de 2024.
    const fullMoonConditions = assessNightSky(new Date(Date.UTC(2024, 3, 24, 0, 0)), null);
    expect(fullMoonConditions.moonIlluminatedFraction).toBeGreaterThan(0.97);
    expect(fullMoonConditions.sunAltitudeDegrees).toBeNull();
    expect(fullMoonConditions.moonInterference).toBe('strong');
  });
});
