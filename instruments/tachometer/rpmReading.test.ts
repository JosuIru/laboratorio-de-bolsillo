import { createReadingStabilizer, frequencyToRevolutionsPerMinute, revolutionsPerMinuteToFrequency } from './rpmReading';

describe('frequencyToRevolutionsPerMinute', () => {
  it('divide la frecuencia de los pulsos entre los pulsos por vuelta', () => {
    expect(frequencyToRevolutionsPerMinute(50, 1)).toBe(3000);
    // Ventilador de 5 aspas a 1200 rpm: 100 soplidos por segundo.
    expect(frequencyToRevolutionsPerMinute(100, 5)).toBe(1200);
    expect(revolutionsPerMinuteToFrequency(1200, 5)).toBe(100);
  });

  it('rechaza pulsos por vuelta no enteros o menores que 1', () => {
    expect(() => frequencyToRevolutionsPerMinute(50, 0)).toThrow(RangeError);
    expect(() => frequencyToRevolutionsPerMinute(50, 2.5)).toThrow(RangeError);
  });
});

describe('createReadingStabilizer', () => {
  it('da la mediana e ignora una lectura suelta disparatada', () => {
    const readingStabilizer = createReadingStabilizer();
    let stabilizedReading = null;
    for (const frequencyHz of [100, 100.2, 99.9, 400, 100.1, 100]) stabilizedReading = readingStabilizer.push(frequencyHz);
    expect(stabilizedReading!.medianFrequencyHz).toBeCloseTo(100.05, 6);
    expect(stabilizedReading!.isStable).toBe(true);
  });

  it('no da por estable un régimen que cambia ni con pocas lecturas', () => {
    const acceleratingStabilizer = createReadingStabilizer();
    let acceleratingReading = null;
    for (const frequencyHz of [80, 85, 90, 95, 100, 105]) acceleratingReading = acceleratingStabilizer.push(frequencyHz);
    expect(acceleratingReading!.isStable).toBe(false);

    const shortStabilizer = createReadingStabilizer();
    shortStabilizer.push(100);
    expect(shortStabilizer.push(100)!.isStable).toBe(false);
  });

  it('una tos no borra la lectura, pero un silencio largo sí', () => {
    const readingStabilizer = createReadingStabilizer({ historyLength: 4 });
    for (const frequencyHz of [100, 100, 100]) readingStabilizer.push(frequencyHz);
    expect(readingStabilizer.push(null)!.medianFrequencyHz).toBe(100);
    for (let silentIndex = 0; silentIndex < 3; silentIndex++) readingStabilizer.push(null);
    expect(readingStabilizer.push(null)).toBeNull();
  });
});
