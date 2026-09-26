import { createSrgbToLinearTable } from '@/processing/color/regionSampling';

import {
  blendProfiles,
  findSpectrumPeaks,
  isCalibrationUsable,
  parseStoredCalibration,
  positionToWavelengthNm,
  sampleProfileAlongLine,
  type WavelengthCalibration,
  wavelengthToDisplayColor,
} from './spectrumEngine';

describe('sampleProfileAlongLine', () => {
  it('lee la intensidad a lo largo de una línea en un fotograma RGBA', () => {
    const frameWidth = 20;
    const frameHeight = 10;
    const bytesPerRow = frameWidth * 4;
    const pixels = new Uint8Array(bytesPerRow * frameHeight);
    // Columna 10 brillante en verde; el resto negro.
    for (let rowIndex = 0; rowIndex < frameHeight; rowIndex++) pixels[rowIndex * bytesPerRow + 10 * 4 + 1] = 200;
    const { intensities, greens } = sampleProfileAlongLine(
      pixels,
      frameWidth,
      frameHeight,
      bytesPerRow,
      'rgba',
      { x: 0, y: 5 },
      { x: 19, y: 5 },
      20,
      2,
    );
    expect(intensities[10]).toBeCloseTo(200, 6);
    expect(greens[10]).toBeCloseTo(200, 6);
    expect(intensities[5]).toBe(0);
  });

  it('con la tabla lineal quita la gamma y cuenta los puntos saturados', () => {
    const frameWidth = 20;
    const frameHeight = 10;
    const bytesPerRow = frameWidth * 4;
    const pixels = new Uint8Array(bytesPerRow * frameHeight);
    for (let rowIndex = 0; rowIndex < frameHeight; rowIndex++) {
      pixels[rowIndex * bytesPerRow + 5 * 4 + 1] = 128;
      pixels[rowIndex * bytesPerRow + 10 * 4 + 1] = 255;
    }
    const { intensities, saturatedSampleCount } = sampleProfileAlongLine(
      pixels,
      frameWidth,
      frameHeight,
      bytesPerRow,
      'rgba',
      { x: 0, y: 5 },
      { x: 19, y: 5 },
      20,
      2,
      createSrgbToLinearTable(),
    );
    // 128 con gamma es ~22 % de luz, no la mitad: un pico el doble de alto sale ~4,6 veces mayor.
    expect(intensities[5]).toBeCloseTo(255 * 0.2158, 0);
    expect(intensities[10]).toBeCloseTo(255, 6);
    expect(saturatedSampleCount).toBe(1);
  });
});

describe('findSpectrumPeaks', () => {
  it('encuentra las líneas de un fluorescente y descarta el ruido', () => {
    const profile = Array.from({ length: 240 }, (_, sampleIndex) => {
      const line = (center: number, height: number) => height * Math.exp(-((sampleIndex - center) ** 2) / 8);
      return 10 + line(40, 300) + line(120, 500) + line(170, 250) + (sampleIndex % 7 === 0 ? 5 : 0);
    });
    const spectrumPeaks = findSpectrumPeaks(profile);
    expect(spectrumPeaks.map((spectrumPeak) => Math.round(spectrumPeak.position))).toEqual([40, 120, 170]);
  });

  it('un perfil plano no tiene picos', () => {
    expect(findSpectrumPeaks(new Array(50).fill(100))).toEqual([]);
  });
});

describe('calibración', () => {
  const mercuryCalibration: WavelengthCalibration = {
    points: [
      { position: 40, wavelengthNm: 435.8 },
      { position: 120, wavelengthNm: 546.1 },
    ],
    calibratedAt: 1,
  };

  it('pasa de posición a nanómetros de forma lineal', () => {
    expect(positionToWavelengthNm(mercuryCalibration, 40)).toBeCloseTo(435.8, 6);
    expect(positionToWavelengthNm(mercuryCalibration, 120)).toBeCloseTo(546.1, 6);
    expect(positionToWavelengthNm(mercuryCalibration, 80)).toBeCloseTo((435.8 + 546.1) / 2, 6);
  });

  it('rechaza calibraciones con los dos puntos casi juntos o corruptas', () => {
    expect(
      isCalibrationUsable({
        ...mercuryCalibration,
        points: [mercuryCalibration.points[0], { position: 42, wavelengthNm: 546.1 }],
      }),
    ).toBe(false);
    expect(parseStoredCalibration(JSON.stringify(mercuryCalibration))).toEqual(mercuryCalibration);
    expect(parseStoredCalibration('{"points":[1,2]}')).toBeNull();
    expect(parseStoredCalibration('roto')).toBeNull();
  });
});

describe('otros', () => {
  it('colores de la luz visible', () => {
    expect(wavelengthToDisplayColor(546)).toMatch(/^#[0-9a-f]{2}ff00$/);
    expect(wavelengthToDisplayColor(700)).toBe('#ff0000');
    expect(wavelengthToDisplayColor(300)).toBe('#000000');
  });

  it('la media exponencial se acerca al perfil nuevo', () => {
    const blendedProfile = blendProfiles(Float64Array.from([0, 10]), Float64Array.from([10, 10]), 0.5);
    expect(Array.from(blendedProfile)).toEqual([5, 10]);
    expect(Array.from(blendProfiles(null, Float64Array.from([3]), 0.5))).toEqual([3]);
  });
});
