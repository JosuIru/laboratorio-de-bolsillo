import { median, type LevelWindow } from './vibrationLevel';

/**
 * Detector del ciclo de una lavadora, secadora o lavavajillas a partir del nivel de vibración
 * por ventanas de ~1 s. Es una función pura: recibe el estado y una ventana, y devuelve el
 * estado siguiente.
 *
 * Fases:
 * 1. `measuringBackground`: con la máquina parada, mide el ruido de fondo y fija el umbral.
 * 2. `waitingForStart`: espera a que el nivel pase del umbral de forma sostenida.
 * 3. `running`: en marcha. Las pausas (remojo, desagüe, reposo entre giros) no lo terminan.
 * 4. `finished`: tras haber estado en marcha un mínimo de tiempo, lleva `quietSecondsToFinish`
 *    seguidos por debajo del umbral. Si se quedó quieta antes de ese mínimo, era un falso
 *    arranque (un golpe, alguien apoyado) y vuelve a esperar.
 */

export type CyclePhase = 'measuringBackground' | 'waitingForStart' | 'running' | 'finished';

export interface CycleDetectorSettings {
  /** Ventanas de ruido de fondo que se miden al empezar. */
  backgroundWindowCount: number;
  /** El umbral es el fondo (mediana) por este factor… */
  backgroundMultiplier: number;
  /** …pero nunca menos que esto (m/s²), para que el ruido del sensor no dispare nada. */
  minimumThreshold: number;
  /** Ventanas que se miran para decidir que ha arrancado. */
  startWindowCount: number;
  /** Fracción de esas ventanas que deben pasar del umbral. */
  startActiveFraction: number;
  /**
   * Actividad sostenida: al menos `activityMinimumCount` de las últimas `activityWindowCount`
   * ventanas por encima del umbral. Un golpe suelto no reinicia la cuenta de la parada.
   */
  activityWindowCount: number;
  activityMinimumCount: number;
  /** Tiempo mínimo en marcha para que una parada cuente como fin de ciclo. */
  minimumRunSeconds: number;
  /** Tiempo seguido por debajo del umbral para dar el ciclo por terminado. */
  quietSecondsToFinish: number;
}

export const defaultCycleDetectorSettings: CycleDetectorSettings = {
  backgroundWindowCount: 10,
  backgroundMultiplier: 3,
  minimumThreshold: 0.01,
  startWindowCount: 20,
  startActiveFraction: 0.7,
  activityWindowCount: 5,
  activityMinimumCount: 3,
  minimumRunSeconds: 3 * 60,
  quietSecondsToFinish: 3 * 60,
};

interface RecentWindow {
  startSeconds: number;
  endSeconds: number;
  level: number;
  isAboveThreshold: boolean;
}

export interface CycleDetectorState {
  phase: CyclePhase;
  backgroundLevels: readonly number[];
  /** Mediana del ruido de fondo, o `null` si se saltó la medida («Ya está en marcha»). */
  backgroundLevel: number | null;
  threshold: number | null;
  /** Últimas ventanas, para confirmar el arranque y la actividad sostenida. */
  recentWindows: readonly RecentWindow[];
  cycleStartSeconds: number | null;
  /** Fin de la última ventana con actividad sostenida: donde empieza a contar la parada. */
  lastActiveSeconds: number | null;
  latestSeconds: number | null;
  cycleEndSeconds: number | null;
  /** Suma y número de niveles desde el arranque hasta la última actividad (para el nivel medio). */
  levelSumUntilLastActive: number;
  windowCountUntilLastActive: number;
  /** Lo mismo pero hasta la última ventana, pausas incluidas. */
  levelSumSinceStart: number;
  windowCountSinceStart: number;
  peakLevel: number;
  /** Arranques que no llegaron al mínimo en marcha (informativo). */
  falseStartCount: number;
}

export function createCycleDetectorState(): CycleDetectorState {
  return {
    phase: 'measuringBackground',
    backgroundLevels: [],
    backgroundLevel: null,
    threshold: null,
    recentWindows: [],
    cycleStartSeconds: null,
    lastActiveSeconds: null,
    latestSeconds: null,
    cycleEndSeconds: null,
    levelSumUntilLastActive: 0,
    windowCountUntilLastActive: 0,
    levelSumSinceStart: 0,
    windowCountSinceStart: 0,
    peakLevel: 0,
    falseStartCount: 0,
  };
}

export function thresholdFromBackground(backgroundLevel: number, settings: CycleDetectorSettings): number {
  return Math.max(settings.minimumThreshold, backgroundLevel * settings.backgroundMultiplier);
}

function clearCycle(state: CycleDetectorState): CycleDetectorState {
  return {
    ...state,
    phase: 'waitingForStart',
    recentWindows: [],
    cycleStartSeconds: null,
    lastActiveSeconds: null,
    cycleEndSeconds: null,
    levelSumUntilLastActive: 0,
    windowCountUntilLastActive: 0,
    levelSumSinceStart: 0,
    windowCountSinceStart: 0,
    peakLevel: 0,
  };
}

function keepLatest<Item>(items: readonly Item[], newItem: Item, maximumCount: number): Item[] {
  const updatedItems = [...items, newItem];
  return updatedItems.length > maximumCount ? updatedItems.slice(updatedItems.length - maximumCount) : updatedItems;
}

function hasSustainedActivity(recentWindows: readonly RecentWindow[], settings: CycleDetectorSettings): boolean {
  const lastWindows = recentWindows.slice(-settings.activityWindowCount);
  const activeCount = lastWindows.filter((recentWindow) => recentWindow.isAboveThreshold).length;
  return activeCount >= settings.activityMinimumCount;
}

/** Procesa una ventana de nivel y devuelve el estado siguiente. */
export function advanceCycleDetector(
  state: CycleDetectorState,
  levelWindow: LevelWindow,
  settings: CycleDetectorSettings,
): CycleDetectorState {
  if (state.phase === 'finished') return state;
  const latestState = { ...state, latestSeconds: levelWindow.endSeconds };

  if (state.phase === 'measuringBackground') {
    const backgroundLevels = [...state.backgroundLevels, levelWindow.level];
    if (backgroundLevels.length < settings.backgroundWindowCount) return { ...latestState, backgroundLevels };
    const backgroundLevel = median(backgroundLevels);
    return {
      ...clearCycle(latestState),
      backgroundLevels,
      backgroundLevel,
      threshold: thresholdFromBackground(backgroundLevel, settings),
    };
  }

  const threshold = state.threshold ?? settings.minimumThreshold;
  const recentWindowCount = Math.max(settings.startWindowCount, settings.activityWindowCount);
  const recentWindows = keepLatest(
    state.recentWindows,
    {
      startSeconds: levelWindow.startSeconds,
      endSeconds: levelWindow.endSeconds,
      level: levelWindow.level,
      isAboveThreshold: levelWindow.level > threshold,
    },
    recentWindowCount,
  );

  if (state.phase === 'waitingForStart') {
    const startWindows = recentWindows.slice(-settings.startWindowCount);
    const activeCount = startWindows.filter((recentWindow) => recentWindow.isAboveThreshold).length;
    const isStartConfirmed =
      startWindows.length >= settings.startWindowCount &&
      activeCount >= settings.startActiveFraction * settings.startWindowCount &&
      levelWindow.level > threshold;
    if (!isStartConfirmed) return { ...latestState, recentWindows };
    // El ciclo empezó en la primera ventana activa del tramo que lo confirma, no ahora.
    const firstActiveIndex = startWindows.findIndex((recentWindow) => recentWindow.isAboveThreshold);
    const cycleWindows = startWindows.slice(firstActiveIndex);
    const levelSum = cycleWindows.reduce((sum, recentWindow) => sum + recentWindow.level, 0);
    return {
      ...latestState,
      phase: 'running',
      recentWindows,
      cycleStartSeconds: cycleWindows[0]!.startSeconds,
      lastActiveSeconds: levelWindow.endSeconds,
      levelSumUntilLastActive: levelSum,
      windowCountUntilLastActive: cycleWindows.length,
      levelSumSinceStart: levelSum,
      windowCountSinceStart: cycleWindows.length,
      peakLevel: Math.max(...cycleWindows.map((recentWindow) => recentWindow.level)),
    };
  }

  // En marcha.
  const levelSumSinceStart = state.levelSumSinceStart + levelWindow.level;
  const windowCountSinceStart = state.windowCountSinceStart + 1;
  const peakLevel = Math.max(state.peakLevel, levelWindow.level);
  const isActiveNow = levelWindow.level > threshold && hasSustainedActivity(recentWindows, settings);
  const runningState: CycleDetectorState = {
    ...latestState,
    recentWindows,
    levelSumSinceStart,
    windowCountSinceStart,
    peakLevel,
    ...(isActiveNow
      ? {
          lastActiveSeconds: levelWindow.endSeconds,
          levelSumUntilLastActive: levelSumSinceStart,
          windowCountUntilLastActive: windowCountSinceStart,
        }
      : {}),
  };

  const lastActiveSeconds = runningState.lastActiveSeconds ?? levelWindow.endSeconds;
  const quietSeconds = levelWindow.endSeconds - lastActiveSeconds;
  if (quietSeconds < settings.quietSecondsToFinish) return runningState;

  const runSeconds = lastActiveSeconds - (runningState.cycleStartSeconds ?? lastActiveSeconds);
  if (runSeconds < settings.minimumRunSeconds) {
    return { ...clearCycle(runningState), falseStartCount: state.falseStartCount + 1 };
  }
  return { ...runningState, phase: 'finished', cycleEndSeconds: lastActiveSeconds };
}

/**
 * «Ya está en marcha»: para cuando se empieza a vigilar con la máquina funcionando (el fondo
 * saldría altísimo). Usa el umbral de reserva, o el medido si es más bajo, y cuenta el ciclo
 * desde ahora: la duración será la parte vigilada.
 */
export function assumeAlreadyRunning(
  state: CycleDetectorState,
  nowSeconds: number,
  fallbackThreshold: number,
): CycleDetectorState {
  if (state.phase === 'running' || state.phase === 'finished') return state;
  return {
    ...clearCycle(state),
    phase: 'running',
    threshold: Math.min(state.threshold ?? fallbackThreshold, fallbackThreshold),
    cycleStartSeconds: nowSeconds,
    lastActiveSeconds: nowSeconds,
    latestSeconds: nowSeconds,
  };
}

/** Datos para mostrar y guardar, derivados del estado. */
export interface CycleSummary {
  /** Segundos en marcha: del arranque a la última actividad (o hasta ahora si sigue). */
  runSeconds: number;
  /** Segundos seguidos por debajo del umbral mientras está en marcha. */
  quietSeconds: number;
  meanLevel: number;
  peakLevel: number;
}

export function summarizeCycle(state: CycleDetectorState): CycleSummary | null {
  if (state.cycleStartSeconds === null || state.lastActiveSeconds === null) return null;
  const latestSeconds = state.latestSeconds ?? state.lastActiveSeconds;
  const endSeconds = state.cycleEndSeconds ?? state.lastActiveSeconds;
  return {
    runSeconds: Math.max(0, endSeconds - state.cycleStartSeconds),
    quietSeconds: state.phase === 'running' ? Math.max(0, latestSeconds - state.lastActiveSeconds) : 0,
    meanLevel:
      state.windowCountUntilLastActive > 0 ? state.levelSumUntilLastActive / state.windowCountUntilLastActive : 0,
    peakLevel: state.peakLevel,
  };
}
