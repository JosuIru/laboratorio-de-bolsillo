import { parseStoredFloorPlan } from './floorPlanStorage';

const validRoom = { left: 0, top: 0, right: 0.5, bottom: 0.4 };
const validPoint = { x: 0.25, y: 0.2, rssiDbm: -58.3, frequencyMhz: 5180, sampleCount: 12 };

describe('parseStoredFloorPlan', () => {
  it('lee habitaciones y puntos válidos', () => {
    const storedText = JSON.stringify({ rooms: [validRoom], mappedPoints: [validPoint] });
    expect(parseStoredFloorPlan(storedText)).toEqual({ rooms: [validRoom], mappedPoints: [validPoint] });
  });

  it('descarta habitaciones sin área o fuera del plano y puntos corruptos', () => {
    const storedText = JSON.stringify({
      rooms: [validRoom, { left: 0.5, top: 0, right: 0.5, bottom: 1 }, { left: 0, top: 0, right: 1.5, bottom: 1 }, null],
      mappedPoints: [
        validPoint,
        { ...validPoint, x: -0.1 },
        { ...validPoint, rssiDbm: 'fuerte' },
        { ...validPoint, rssiDbm: 0 },
        'punto',
      ],
    });
    expect(parseStoredFloorPlan(storedText)).toEqual({ rooms: [validRoom], mappedPoints: [validPoint] });
  });

  it('rellena la frecuencia y el número de muestras que falten', () => {
    const storedText = JSON.stringify({ rooms: [], mappedPoints: [{ x: 0.5, y: 0.5, rssiDbm: -70 }] });
    expect(parseStoredFloorPlan(storedText).mappedPoints).toEqual([
      { x: 0.5, y: 0.5, rssiDbm: -70, frequencyMhz: 0, sampleCount: 0 },
    ]);
  });

  it('devuelve un plano vacío con JSON roto, nulo o de otro tipo', () => {
    const emptyFloorPlan = { rooms: [], mappedPoints: [] };
    expect(parseStoredFloorPlan('{roto')).toEqual(emptyFloorPlan);
    expect(parseStoredFloorPlan(null)).toEqual(emptyFloorPlan);
    expect(parseStoredFloorPlan('null')).toEqual(emptyFloorPlan);
    expect(parseStoredFloorPlan(JSON.stringify([validRoom]))).toEqual(emptyFloorPlan);
    expect(parseStoredFloorPlan(JSON.stringify({ rooms: 'salón', mappedPoints: 3 }))).toEqual(emptyFloorPlan);
  });
});
