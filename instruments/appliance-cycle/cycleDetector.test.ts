import {
  advanceCycleDetector,
  assumeAlreadyRunning,
  createCycleDetectorState,
  type CycleDetectorSettings,
  type CycleDetectorState,
  defaultCycleDetectorSettings,
  summarizeCycle,
} from './cycleDetector';

const testSettings: CycleDetectorSettings = {
  ...defaultCycleDetectorSettings,
  backgroundWindowCount: 10,
  backgroundMultiplier: 3,
  minimumThreshold: 0.01,
  minimumRunSeconds: 180,
  quietSecondsToFinish: 180,
};

const backgroundLevel = 0.01;
const quietLevel = 0.012;
const runningLevel = 0.2;

/** Pasa niveles de ventanas de 1 s seguidas, empezando donde lo dejó el estado. */
function feedLevels(
  initialState: CycleDetectorState,
  levels: readonly number[],
  settings: CycleDetectorSettings = testSettings,
): CycleDetectorState {
  let detectorState = initialState;
  for (const level of levels) {
    const startSeconds = detectorState.latestSeconds ?? 0;
    detectorState = advanceCycleDetector(
      detectorState,
      { startSeconds, endSeconds: startSeconds + 1, level, sampleCount: 50 },
      settings,
    );
  }
  return detectorState;
}

const repeatLevel = (level: number, windowCount: number) => Array<number>(windowCount).fill(level);

function calibratedState(): CycleDetectorState {
  return feedLevels(createCycleDetectorState(), repeatLevel(backgroundLevel, 10));
}

describe('advanceCycleDetector', () => {
  it('mide el fondo y fija el umbral con la mediana (un golpe durante la medida no lo sube)', () => {
    const detectorState = feedLevels(createCycleDetectorState(), [...repeatLevel(backgroundLevel, 9), 1]);
    expect(detectorState.phase).toBe('waitingForStart');
    expect(detectorState.backgroundLevel).toBeCloseTo(backgroundLevel);
    expect(detectorState.threshold).toBeCloseTo(0.03);
  });

  it('el umbral nunca baja del mínimo aunque el fondo sea casi cero', () => {
    const detectorState = feedLevels(createCycleDetectorState(), repeatLevel(0.0005, 10));
    expect(detectorState.threshold).toBe(testSettings.minimumThreshold);
  });

  it('un golpe corto no cuenta como arranque', () => {
    const detectorState = feedLevels(calibratedState(), [...repeatLevel(runningLevel, 5), ...repeatLevel(quietLevel, 30)]);
    expect(detectorState.phase).toBe('waitingForStart');
  });

  it('arranca con vibración sostenida y fecha el inicio en la primera ventana activa', () => {
    const detectorState = feedLevels(calibratedState(), [...repeatLevel(quietLevel, 5), ...repeatLevel(runningLevel, 20)]);
    expect(detectorState.phase).toBe('running');
    // 10 s de fondo + 5 s quieta: la primera ventana activa empieza en el segundo 15.
    expect(detectorState.cycleStartSeconds).toBe(15);
  });

  it('una pausa a mitad de ciclo más corta que el tiempo de espera no lo termina', () => {
    const detectorState = feedLevels(calibratedState(), [
      ...repeatLevel(runningLevel, 300),
      ...repeatLevel(quietLevel, 150),
      ...repeatLevel(runningLevel, 300),
    ]);
    expect(detectorState.phase).toBe('running');
  });

  it('termina tras el tiempo de espera quieta y da la duración hasta la última vibración', () => {
    const runningState = feedLevels(calibratedState(), repeatLevel(runningLevel, 600));
    const almostFinishedState = feedLevels(runningState, repeatLevel(quietLevel, 179));
    expect(almostFinishedState.phase).toBe('running');
    expect(summarizeCycle(almostFinishedState)?.quietSeconds).toBe(179);

    const finishedState = feedLevels(almostFinishedState, repeatLevel(quietLevel, 1));
    expect(finishedState.phase).toBe('finished');
    expect(finishedState.cycleStartSeconds).toBe(10);
    expect(finishedState.cycleEndSeconds).toBe(610);
    const cycleSummary = summarizeCycle(finishedState)!;
    expect(cycleSummary.runSeconds).toBe(600);
    // El nivel medio es el de la máquina en marcha, sin la cola quieta del final.
    expect(cycleSummary.meanLevel).toBeCloseTo(runningLevel);
    expect(cycleSummary.peakLevel).toBeCloseTo(runningLevel);
  });

  it('los golpes sueltos durante la parada no reinician la cuenta', () => {
    const quietWithBumps = repeatLevel(quietLevel, 180);
    quietWithBumps[40] = 1;
    quietWithBumps[120] = 1;
    quietWithBumps[121] = 1;
    const detectorState = feedLevels(calibratedState(), [...repeatLevel(runningLevel, 600), ...quietWithBumps]);
    expect(detectorState.phase).toBe('finished');
    expect(detectorState.cycleEndSeconds).toBe(610);
  });

  it('una parada tras muy poco tiempo en marcha es un falso arranque y vuelve a esperar', () => {
    const detectorState = feedLevels(calibratedState(), [...repeatLevel(runningLevel, 60), ...repeatLevel(quietLevel, 180)]);
    expect(detectorState.phase).toBe('waitingForStart');
    expect(detectorState.falseStartCount).toBe(1);
    expect(detectorState.cycleStartSeconds).toBeNull();
    expect(detectorState.threshold).toBeCloseTo(0.03);
  });

  it('respeta un tiempo de espera distinto', () => {
    const shortQuietSettings = { ...testSettings, quietSecondsToFinish: 60 };
    const detectorState = feedLevels(
      calibratedState(),
      [...repeatLevel(runningLevel, 600), ...repeatLevel(quietLevel, 60)],
      shortQuietSettings,
    );
    expect(detectorState.phase).toBe('finished');
  });

  it('una vez terminado no cambia', () => {
    const finishedState = feedLevels(calibratedState(), [...repeatLevel(runningLevel, 600), ...repeatLevel(quietLevel, 180)]);
    expect(feedLevels(finishedState, repeatLevel(runningLevel, 30))).toBe(finishedState);
  });
});

describe('assumeAlreadyRunning', () => {
  it('sin fondo medido usa el umbral de reserva y cuenta desde ahora', () => {
    const detectorState = assumeAlreadyRunning(createCycleDetectorState(), 1000, 0.05);
    expect(detectorState.phase).toBe('running');
    expect(detectorState.threshold).toBe(0.05);
    expect(detectorState.cycleStartSeconds).toBe(1000);
  });

  it('si el fondo se midió con la máquina en marcha, el umbral no pasa del de reserva', () => {
    const noisyCalibration = feedLevels(createCycleDetectorState(), repeatLevel(runningLevel, 10));
    expect(noisyCalibration.threshold).toBeCloseTo(0.6);
    expect(assumeAlreadyRunning(noisyCalibration, 10, 0.05).threshold).toBe(0.05);
  });

  it('con un fondo bajo conserva el umbral medido', () => {
    expect(assumeAlreadyRunning(calibratedState(), 10, 0.05).threshold).toBeCloseTo(0.03);
  });

  it('después termina como un ciclo normal', () => {
    const runningState = assumeAlreadyRunning(calibratedState(), 10, 0.05);
    const detectorState = feedLevels(runningState, [...repeatLevel(runningLevel, 300), ...repeatLevel(quietLevel, 180)]);
    expect(detectorState.phase).toBe('finished');
    expect(summarizeCycle(detectorState)?.runSeconds).toBe(300);
  });
});
