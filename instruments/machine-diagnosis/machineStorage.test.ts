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
      {
        id: 'bomba',
        name: 'Bomba del pozo',
        baselineRecordings: [validBaseline],
        baseline: { ...validBaseline, recordingCount: 1 },
      },
      { id: 'lavadora', name: 'Lavadora', baselineRecordings: [], baseline: null },
    ]);
  });

  it('combina las grabaciones de la huella base', () => {
    const louderRecording = {
      ...validBaseline,
      capturedAt: validBaseline.capturedAt + 60_000,
      audio: { ...validBaseline.audio, bandLevelsDecibels: [-36, -45], overallLevelDecibels: -35.5 },
    };
    const [machine] = parseStoredMachines(
      JSON.stringify([{ id: 'bomba', name: 'Bomba', baselineRecordings: [validBaseline, louderRecording] }]),
    );
    expect(machine!.baselineRecordings).toHaveLength(2);
    expect(machine!.baseline!.recordingCount).toBe(2);
    expect(machine!.baseline!.capturedAt).toBe(louderRecording.capturedAt);
    expect(machine!.baseline!.audio!.bandSpreadDecibels![0]).toBeGreaterThan(1);
  });

  it('descarta huellas corruptas pero conserva la máquina', () => {
    const corruptBaseline = {
      ...validBaseline,
      audio: { bandCentersHz: [100, 125], bandLevelsDecibels: [-40], overallLevelDecibels: -38 },
    };
    expect(parseStoredMachines(JSON.stringify([{ id: 'a', name: 'A', baseline: corruptBaseline }]))).toEqual([
      { id: 'a', name: 'A', baselineRecordings: [], baseline: null },
    ]);
  });

  it('ignora entradas sin id o nombre, y JSON roto', () => {
    expect(parseStoredMachines(JSON.stringify([{ name: 'sin id' }, { id: 7, name: 'id numérico' }]))).toEqual([]);
    expect(parseStoredMachines('{roto')).toEqual([]);
    expect(parseStoredMachines(null)).toEqual([]);
  });
});
