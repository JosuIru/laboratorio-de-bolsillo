import { parseStoredMachines } from './machineStorage';

const validBaseline = {
  audio: { bandCentersHz: [100, 125], bandLevelsDecibels: [-40, -45], overallLevelDecibels: -38.8, frameCount: 90 },
  vibration: null,
  capturedAt: 1_758_000_000_000,
  durationSeconds: 10,
};

describe('parseStoredMachines', () => {
  it('lee máquinas válidas, con y sin huella', () => {
    const storedText = JSON.stringify([
      { id: 'bomba', name: 'Bomba del pozo', baseline: validBaseline },
      { id: 'lavadora', name: 'Lavadora', baseline: null },
    ]);
    expect(parseStoredMachines(storedText)).toEqual([
      { id: 'bomba', name: 'Bomba del pozo', baseline: validBaseline },
      { id: 'lavadora', name: 'Lavadora', baseline: null },
    ]);
  });

  it('descarta huellas corruptas pero conserva la máquina', () => {
    const corruptBaseline = {
      ...validBaseline,
      audio: { bandCentersHz: [100, 125], bandLevelsDecibels: [-40], overallLevelDecibels: -38 },
    };
    expect(parseStoredMachines(JSON.stringify([{ id: 'a', name: 'A', baseline: corruptBaseline }]))).toEqual([
      { id: 'a', name: 'A', baseline: null },
    ]);
  });

  it('ignora entradas sin id o nombre, y JSON roto', () => {
    expect(parseStoredMachines(JSON.stringify([{ name: 'sin id' }, { id: 7, name: 'id numérico' }]))).toEqual([]);
    expect(parseStoredMachines('{roto')).toEqual([]);
    expect(parseStoredMachines(null)).toEqual([]);
  });
});
