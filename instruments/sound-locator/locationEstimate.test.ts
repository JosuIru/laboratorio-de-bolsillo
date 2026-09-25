import { simulateIntervals } from '@/processing/localization/multilateration';
import { speedOfSoundMetersPerSecond } from '@/processing/sonar/soundSpeed';

import { estimateLocation, parseReceiverRows } from './locationEstimate';
import { layoutPresetPositions } from './locatorConfiguration';

describe('parseReceiverRows', () => {
  it('acepta coma decimal y pasa los intervalos a segundos', () => {
    const parsedRows = parseReceiverRows([
      { xText: '0', yText: '0', intervalText: '1234,5' },
      { xText: '2', yText: '0', intervalText: '1233.25' },
      { xText: '1', yText: '1,732', intervalText: '1235' },
    ]);
    expect(parsedRows.status).toBe('ok');
    if (parsedRows.status !== 'ok') return;
    expect(parsedRows.intervalsSeconds[0]).toBeCloseTo(1.2345, 9);
    expect(parsedRows.receiverPositions[2]).toEqual({ x: 1, y: 1.732 });
  });

  it('distingue filas incompletas y móviles repetidos', () => {
    expect(parseReceiverRows([{ xText: '0', yText: '', intervalText: '1' }]).status).toBe('incomplete');
    expect(
      parseReceiverRows([
        { xText: '0', yText: '0', intervalText: '1' },
        { xText: '0', yText: '0.01', intervalText: '1' },
      ]).status,
    ).toBe('duplicatePositions');
  });
});

describe('estimateLocation', () => {
  const receiverPositions = [...layoutPresetPositions.square];
  const temperatureCelsius = 22;
  const speedOfSound = speedOfSoundMetersPerSecond(temperatureCelsius);

  it('encuentra la palmada con los intervalos tal como los enseñan los móviles', () => {
    const emitterIndex = 2;
    const intervalsSeconds = simulateIntervals(
      { x: 0.6, y: 1.5 },
      receiverPositions,
      receiverPositions[emitterIndex]!,
      speedOfSound,
      0.9,
    ).map((intervalSeconds) => Math.round(intervalSeconds * 1e5) / 1e5);
    const locationEstimate = estimateLocation(receiverPositions, intervalsSeconds, emitterIndex, temperatureCelsius);
    expect(locationEstimate.solution!.position.x).toBeCloseTo(0.6, 2);
    expect(locationEstimate.solution!.position.y).toBeCloseTo(1.5, 2);
    expect(locationEstimate.isInconsistent).toBe(false);
    expect(locationEstimate.impossibleReceiverIndices).toEqual([]);
  });

  it('señala un número mal copiado', () => {
    const intervalsSeconds = simulateIntervals({ x: 1, y: 1 }, receiverPositions, receiverPositions[0]!, speedOfSound, 1);
    intervalsSeconds[1] = intervalsSeconds[1]! + 0.01;
    const locationEstimate = estimateLocation(receiverPositions, intervalsSeconds, 0, temperatureCelsius);
    expect(locationEstimate.impossibleReceiverIndices).toEqual([1]);
  });
});
