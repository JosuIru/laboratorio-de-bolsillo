import type { RegionCellBounds } from './measurementRegion';

/**
 * Mapas del movimiento, celda a celda de la rejilla filtrada (el nivel grueso de la pirámide):
 *
 * - **Mapa de calor**: amplitud de la señal filtrada, como valor eficaz (RMS) con media
 *   exponencial. Dice dónde cambia más la imagen dentro de la banda.
 * - **Mapa de fase**: detección síncrona (lock-in) a la frecuencia dominante f0. Cada serie se
 *   multiplica por cos y sin de 2π·f0·t y se promedia (media exponencial): de ahí salen la
 *   amplitud y la fase de la componente a f0. Las zonas que se mueven a la vez tienen la misma
 *   fase; las que van a contratiempo, la opuesta. La fase se da relativa a la de la zona de
 *   medida, así los colores no giran si f0 está un poco desviada.
 *
 * Todo trabaja sobre arrays tipados reutilizados: nada se reserva por fotograma.
 */

export interface MotionMapState {
  gridWidth: number;
  gridHeight: number;
  /** Media exponencial del cuadrado de la señal filtrada, por celda. */
  meanSquares: Float32Array;
  /** Componentes en fase (x·cos) y en cuadratura (x·sin) promediadas, por celda. */
  inPhaseAverages: Float32Array;
  quadratureAverages: Float32Array;
  /** Amplitudes calculadas para pintar (reutilizado). */
  amplitudeScratch: Float32Array;
  lockInFrequencyHz: number | null;
  /** Tiempo acumulado del lock-in desde que se fijó f0: pesa la media al principio. */
  lockInElapsedSeconds: number;
  amplitudeElapsedSeconds: number;
  /** Máximo de la escala de color, suavizado para que la imagen no parpadee. */
  heatDisplayMaximum: number;
  phaseDisplayMaximum: number;
}

export function createMotionMapState(gridWidth: number, gridHeight: number): MotionMapState {
  const cellCount = gridWidth * gridHeight;
  return {
    gridWidth,
    gridHeight,
    meanSquares: new Float32Array(cellCount),
    inPhaseAverages: new Float32Array(cellCount),
    quadratureAverages: new Float32Array(cellCount),
    amplitudeScratch: new Float32Array(cellCount),
    lockInFrequencyHz: null,
    lockInElapsedSeconds: 0,
    amplitudeElapsedSeconds: 0,
    heatDisplayMaximum: 0,
    phaseDisplayMaximum: 0,
  };
}

export function resetMotionMapState(state: MotionMapState): void {
  state.meanSquares.fill(0);
  state.inPhaseAverages.fill(0);
  state.quadratureAverages.fill(0);
  state.lockInElapsedSeconds = 0;
  state.amplitudeElapsedSeconds = 0;
  state.heatDisplayMaximum = 0;
  state.phaseDisplayMaximum = 0;
}

/**
 * Peso de la muestra nueva en una media exponencial con constante de tiempo `timeConstantSeconds`.
 * Al principio (poco tiempo acumulado) pesa más, para que la media arranque sin sesgo hacia 0.
 */
export function exponentialSmoothingWeight(
  stepSeconds: number,
  timeConstantSeconds: number,
  elapsedSeconds = Infinity,
): number {
  const steadyWeight = 1 - Math.exp(-Math.max(0, stepSeconds) / timeConstantSeconds);
  const warmUpWeight = elapsedSeconds > 0 ? Math.min(1, stepSeconds / elapsedSeconds) : 1;
  return Math.max(steadyWeight, warmUpWeight);
}

/** Constante de tiempo del mapa de calor: unos dos periodos del centro de la banda (0,75-6 s). */
export function amplitudeTimeConstantSeconds(lowCutoffHz: number, highCutoffHz: number): number {
  const centerFrequencyHz = Math.sqrt(lowCutoffHz * highCutoffHz);
  return Math.min(6, Math.max(0.75, 2 / centerFrequencyHz));
}

/** Constante de tiempo del lock-in: unos tres periodos de f0 (1-12 s); más larga = menos ruido. */
export function lockInTimeConstantSeconds(lockInFrequencyHz: number): number {
  return Math.min(12, Math.max(1, 3 / lockInFrequencyHz));
}

/** Si f0 cambia más que esto, la media del lock-in se empieza de nuevo. */
const lockInFrequencyRestartTolerance = 0.2;

/** Fija la frecuencia del lock-in; con un cambio grande (o null) olvida lo promediado. */
export function setLockInFrequency(state: MotionMapState, lockInFrequencyHz: number | null): void {
  const previousFrequencyHz = state.lockInFrequencyHz;
  const isValidFrequency = lockInFrequencyHz !== null && Number.isFinite(lockInFrequencyHz) && lockInFrequencyHz > 0;
  const nextFrequencyHz = isValidFrequency ? lockInFrequencyHz : null;
  const isLargeChange =
    nextFrequencyHz === null ||
    previousFrequencyHz === null ||
    Math.abs(nextFrequencyHz - previousFrequencyHz) / previousFrequencyHz > lockInFrequencyRestartTolerance;
  state.lockInFrequencyHz = nextFrequencyHz;
  if (isLargeChange) {
    state.inPhaseAverages.fill(0);
    state.quadratureAverages.fill(0);
    state.lockInElapsedSeconds = 0;
    state.phaseDisplayMaximum = 0;
  }
}

/**
 * Actualiza, con un fotograma filtrado, el RMS de cada celda y (si hay f0) el lock-in.
 * `filteredLevel` tiene `channelCount` canales intercalados y se usa el `channelIndex`.
 */
export function updateMotionMaps(
  state: MotionMapState,
  filteredLevel: ArrayLike<number>,
  channelCount: number,
  channelIndex: number,
  timeSeconds: number,
  stepSeconds: number,
  amplitudeTimeConstant: number,
): void {
  const cellCount = state.gridWidth * state.gridHeight;
  state.amplitudeElapsedSeconds += stepSeconds;
  const amplitudeWeight = exponentialSmoothingWeight(stepSeconds, amplitudeTimeConstant, state.amplitudeElapsedSeconds);
  const { meanSquares } = state;

  const lockInFrequencyHz = state.lockInFrequencyHz;
  if (lockInFrequencyHz === null) {
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
      const filteredValue = filteredLevel[cellIndex * channelCount + channelIndex]!;
      meanSquares[cellIndex] = meanSquares[cellIndex]! + amplitudeWeight * (filteredValue * filteredValue - meanSquares[cellIndex]!);
    }
    return;
  }

  state.lockInElapsedSeconds += stepSeconds;
  const lockInWeight = exponentialSmoothingWeight(
    stepSeconds,
    lockInTimeConstantSeconds(lockInFrequencyHz),
    state.lockInElapsedSeconds,
  );
  // Referencia: un solo cos y sin por fotograma, no por celda.
  const referenceAngle = 2 * Math.PI * lockInFrequencyHz * timeSeconds;
  const referenceCosine = Math.cos(referenceAngle);
  const referenceSine = Math.sin(referenceAngle);
  const { inPhaseAverages, quadratureAverages } = state;
  for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
    const filteredValue = filteredLevel[cellIndex * channelCount + channelIndex]!;
    meanSquares[cellIndex] = meanSquares[cellIndex]! + amplitudeWeight * (filteredValue * filteredValue - meanSquares[cellIndex]!);
    inPhaseAverages[cellIndex] =
      inPhaseAverages[cellIndex]! + lockInWeight * (filteredValue * referenceCosine - inPhaseAverages[cellIndex]!);
    quadratureAverages[cellIndex] =
      quadratureAverages[cellIndex]! + lockInWeight * (filteredValue * referenceSine - quadratureAverages[cellIndex]!);
  }
}

/**
 * Amplitud y fase de la componente a f0 de una celda. Para x(t) = A·cos(2π·f0·t + φ), las medias
 * valen ⟨x·cos⟩ = A/2·cos φ y ⟨x·sin⟩ = −A/2·sin φ.
 */
export function lockInAmplitudeAndPhase(state: MotionMapState, cellIndex: number): { amplitude: number; phaseRadians: number } {
  const inPhase = state.inPhaseAverages[cellIndex]!;
  const quadrature = state.quadratureAverages[cellIndex]!;
  return { amplitude: 2 * Math.hypot(inPhase, quadrature), phaseRadians: Math.atan2(-quadrature, inPhase) };
}

/** Coherencia mínima de la zona de medida para usar su fase media como referencia. */
const minimumReferenceCoherence = 0.3;

/**
 * Fase de referencia: la de la zona de medida. Se suman los fasores de sus celdas; si se cancelan
 * (un movimiento con bordes en contrafase dentro de la zona) se usa la celda más fuerte.
 */
export function referencePhaseOfRegion(state: MotionMapState, regionBounds: RegionCellBounds): number | null {
  let phasorSumReal = 0;
  let phasorSumImaginary = 0;
  let magnitudeSum = 0;
  let strongestMagnitude = 0;
  let strongestPhase = 0;
  for (let regionRow = 0; regionRow < regionBounds.regionHeight; regionRow++) {
    const rowStart = (regionBounds.firstRow + regionRow) * state.gridWidth + regionBounds.firstColumn;
    for (let regionColumn = 0; regionColumn < regionBounds.regionWidth; regionColumn++) {
      const cellIndex = rowStart + regionColumn;
      const phasorReal = state.inPhaseAverages[cellIndex]!;
      const phasorImaginary = -state.quadratureAverages[cellIndex]!;
      const phasorMagnitude = Math.hypot(phasorReal, phasorImaginary);
      phasorSumReal += phasorReal;
      phasorSumImaginary += phasorImaginary;
      magnitudeSum += phasorMagnitude;
      if (phasorMagnitude > strongestMagnitude) {
        strongestMagnitude = phasorMagnitude;
        strongestPhase = Math.atan2(phasorImaginary, phasorReal);
      }
    }
  }
  if (!(magnitudeSum > 0)) return null;
  const coherence = Math.hypot(phasorSumReal, phasorSumImaginary) / magnitudeSum;
  return coherence >= minimumReferenceCoherence ? Math.atan2(phasorSumImaginary, phasorSumReal) : strongestPhase;
}

const histogramBinCount = 128;
const histogramCounts = new Uint32Array(histogramBinCount);

/**
 * Percentiles bajo (10 %), mediana y alto (98 %) de unos valores no negativos, aproximados con un
 * histograma de 128 cajas (O(n), sin ordenar). Sirven para escalar el color: el percentil alto
 * marca el máximo y el bajo (el «fondo» de ruido de las zonas quietas) impide que el ruido llene
 * la escala cuando no se mueve nada.
 */
export function robustAmplitudeStatistics(
  values: ArrayLike<number>,
  valueCount: number,
): { lower: number; median: number; upper: number } {
  const lowerPercentile = 0.1;
  const upperPercentile = 0.98;
  let maximumValue = 0;
  for (let valueIndex = 0; valueIndex < valueCount; valueIndex++) {
    const value = values[valueIndex]!;
    if (value > maximumValue) maximumValue = value;
  }
  if (!(maximumValue > 0) || valueCount === 0) return { lower: 0, median: 0, upper: 0 };
  histogramCounts.fill(0);
  const binScale = histogramBinCount / maximumValue;
  for (let valueIndex = 0; valueIndex < valueCount; valueIndex++) {
    const binIndex = Math.min(histogramBinCount - 1, Math.floor(values[valueIndex]! * binScale));
    histogramCounts[binIndex] = histogramCounts[binIndex]! + 1;
  }
  const binWidth = maximumValue / histogramBinCount;
  let cumulativeCount = 0;
  let lower = maximumValue;
  let median = maximumValue;
  let upper = maximumValue;
  let isLowerFound = false;
  let isMedianFound = false;
  for (let binIndex = 0; binIndex < histogramBinCount; binIndex++) {
    cumulativeCount += histogramCounts[binIndex]!;
    if (!isLowerFound && cumulativeCount >= valueCount * lowerPercentile) {
      lower = (binIndex + 0.5) * binWidth;
      isLowerFound = true;
    }
    if (!isMedianFound && cumulativeCount >= valueCount * 0.5) {
      median = (binIndex + 0.5) * binWidth;
      isMedianFound = true;
    }
    if (cumulativeCount >= valueCount * upperPercentile) {
      upper = (binIndex + 1) * binWidth;
      break;
    }
  }
  return { lower, median, upper };
}

/**
 * El máximo de la escala nunca baja de tantas veces el fondo (percentil 10): el ruido queda tenue.
 * Si más del 90 % de la imagen se mueve igual, el mapa sale apagado y uniforme (no hay contraste
 * que mostrar).
 */
const displayMaximumOverBackground = 4;
/** Suelo absoluto (en niveles 0-255) para no dividir por cero con la imagen quieta. */
const minimumDisplayMaximum = 1e-3;

/**
 * Máximo de la escala suavizado: sube rápido (0,3 s) si aparece un movimiento fuerte y baja
 * despacio (3 s), para que el color no parpadee de un fotograma a otro.
 */
export function smoothDisplayMaximum(previousMaximum: number, targetMaximum: number, stepSeconds: number): number {
  if (!(previousMaximum > 0)) return targetMaximum;
  const timeConstantSeconds = targetMaximum > previousMaximum ? 0.3 : 3;
  return previousMaximum + (1 - Math.exp(-stepSeconds / timeConstantSeconds)) * (targetMaximum - previousMaximum);
}

function displayTargetFromStatistics(statistics: { lower: number; upper: number }): number {
  return Math.max(minimumDisplayMaximum, statistics.upper, displayMaximumOverBackground * statistics.lower);
}

/** Paso suave de 0 a 1 entre `edgeStart` y `edgeEnd`. */
function smoothStep(edgeStart: number, edgeEnd: number, value: number): number {
  const position = Math.min(1, Math.max(0, (value - edgeStart) / (edgeEnd - edgeStart)));
  return position * position * (3 - 2 * position);
}

// ---------------------------------------------------------------------------------------------
// Escalas de color

/**
 * Coeficientes del ajuste polinómico (grado 6) de la escala «inferno» de matplotlib (perceptual:
 * la luminosidad crece de forma uniforme de negro a amarillo pálido). Ajuste de Matt Zucker.
 */
const infernoCoefficients: readonly (readonly [number, number, number])[] = [
  [0.0002189403691192265, 0.001651004631001012, -0.01948089843709184],
  [0.1065134194856116, 0.5639564367884091, 3.932712388889277],
  [11.60249308247187, -3.972853965665698, -15.9423941062914],
  [-41.70399613139459, 17.43639888205313, 44.35414519872813],
  [77.162935699427, -33.40235894210092, -81.80730925738993],
  [-71.31942824499214, 32.62606426397723, 73.20951985803202],
  [25.13112622477341, -12.24266895238567, -23.07032500287172],
];

/** Color «inferno» (0-255) para t en 0-1. */
export function infernoColor(position: number): [number, number, number] {
  const clampedPosition = Math.min(1, Math.max(0, position));
  const colorComponents: [number, number, number] = [0, 0, 0];
  for (let componentIndex = 0; componentIndex < 3; componentIndex++) {
    let polynomialValue = 0;
    for (let degree = infernoCoefficients.length - 1; degree >= 0; degree--) {
      polynomialValue = polynomialValue * clampedPosition + infernoCoefficients[degree]![componentIndex]!;
    }
    colorComponents[componentIndex] = Math.round(255 * Math.min(1, Math.max(0, polynomialValue)));
  }
  return colorComponents;
}

const colorTableSize = 256;
/** Tabla de la escala inferno (RGB intercalado): se evalúa el polinomio una sola vez. */
const infernoColorTable = (() => {
  const colorTable = new Uint8Array(colorTableSize * 3);
  for (let tableIndex = 0; tableIndex < colorTableSize; tableIndex++) {
    colorTable.set(infernoColor(tableIndex / (colorTableSize - 1)), tableIndex * 3);
  }
  return colorTable;
})();

/** Color de una rueda de tonos (HSV con saturación 1) para una fase en radianes; 0 rad = rojo. */
export function phaseHueColor(phaseRadians: number, brightness = 1): [number, number, number] {
  const turnFraction = (((phaseRadians / (2 * Math.PI)) % 1) + 1) % 1;
  const hueSector = turnFraction * 6;
  const sectorIndex = Math.floor(hueSector) % 6;
  const sectorPosition = hueSector - Math.floor(hueSector);
  const rising = sectorPosition;
  const falling = 1 - sectorPosition;
  const sectorColors: readonly (readonly [number, number, number])[] = [
    [1, rising, 0],
    [falling, 1, 0],
    [0, 1, rising],
    [0, falling, 1],
    [rising, 0, 1],
    [1, 0, falling],
  ];
  const sectorColor = sectorColors[sectorIndex]!;
  return [
    Math.round(255 * brightness * sectorColor[0]),
    Math.round(255 * brightness * sectorColor[1]),
    Math.round(255 * brightness * sectorColor[2]),
  ];
}

const phaseTableSize = 360;
/** Tabla de la rueda de fase (RGB intercalado), un tono por grado. */
const phaseColorTable = (() => {
  const colorTable = new Uint8Array(phaseTableSize * 3);
  for (let tableIndex = 0; tableIndex < phaseTableSize; tableIndex++) {
    colorTable.set(phaseHueColor((2 * Math.PI * tableIndex) / phaseTableSize), tableIndex * 3);
  }
  return colorTable;
})();

/** Muestras de la escala inferno para dibujar la leyenda. */
export function infernoLegendColors(sampleCount: number): string[] {
  return Array.from({ length: sampleCount }, (_unused, sampleIndex) => {
    const [red, green, blue] = infernoColor(sampleIndex / Math.max(1, sampleCount - 1));
    return `rgb(${red},${green},${blue})`;
  });
}

/** Tonos de la rueda de fase para la leyenda (el primero y el último coinciden: cierra el círculo). */
export function phaseLegendColors(sampleCount: number): string[] {
  return Array.from({ length: sampleCount }, (_unused, sampleIndex) => {
    const [red, green, blue] = phaseHueColor((2 * Math.PI * sampleIndex) / Math.max(1, sampleCount - 1));
    return `rgb(${red},${green},${blue})`;
  });
}

// ---------------------------------------------------------------------------------------------
// Pintado de los mapas (RGBA sin premultiplicar, del tamaño de la rejilla)

/** Opacidad máxima de los mapas (sobre 255): siempre se ve algo de la imagen de debajo. */
const maximumMapAlpha = 215;

/**
 * Mapa de calor: color inferno y opacidad según la amplitud RMS relativa al máximo de la escala.
 * Donde la amplitud es del orden del fondo (ruido) queda casi transparente.
 */
export function renderHeatMapRgba(state: MotionMapState, stepSeconds: number, outputRgba: Uint8Array): void {
  const cellCount = state.gridWidth * state.gridHeight;
  const amplitudes = state.amplitudeScratch;
  for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
    amplitudes[cellIndex] = Math.sqrt(state.meanSquares[cellIndex]!);
  }
  state.heatDisplayMaximum = smoothDisplayMaximum(
    state.heatDisplayMaximum,
    displayTargetFromStatistics(robustAmplitudeStatistics(amplitudes, cellCount)),
    stepSeconds,
  );
  const inverseMaximum = 1 / state.heatDisplayMaximum;
  for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
    const relativeAmplitude = Math.min(1, amplitudes[cellIndex]! * inverseMaximum);
    const tableOffset = Math.round(relativeAmplitude * (colorTableSize - 1)) * 3;
    const outputOffset = cellIndex * 4;
    outputRgba[outputOffset] = infernoColorTable[tableOffset]!;
    outputRgba[outputOffset + 1] = infernoColorTable[tableOffset + 1]!;
    outputRgba[outputOffset + 2] = infernoColorTable[tableOffset + 2]!;
    outputRgba[outputOffset + 3] = Math.round(maximumMapAlpha * smoothStep(0.15, 0.55, relativeAmplitude));
  }
}

/**
 * Mapa de fase: tono según la fase relativa a la zona de medida (misma fase = mismo color;
 * contrafase = el tono opuesto de la rueda), brillo según la amplitud a f0. La opacidad depende
 * de la coherencia de cada celda: amplitud a f0 frente a la amplitud total en la banda
 * (A / (√2·RMS)); vale ≈ 1 en una oscilación limpia a f0 y ≈ 0,2 con ruido de banda ancha, así
 * que el ruido queda transparente sin depender del resto de la imagen. Las celdas muy débiles
 * frente a las más fuertes también se apagan. Devuelve false (y no pinta) si aún no hay f0 o no
 * hay señal.
 */
export function renderPhaseMapRgba(
  state: MotionMapState,
  regionBounds: RegionCellBounds,
  stepSeconds: number,
  outputRgba: Uint8Array,
): boolean {
  if (state.lockInFrequencyHz === null) return false;
  const referencePhase = referencePhaseOfRegion(state, regionBounds);
  if (referencePhase === null) return false;
  const cellCount = state.gridWidth * state.gridHeight;
  const amplitudes = state.amplitudeScratch;
  for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
    amplitudes[cellIndex] = 2 * Math.hypot(state.inPhaseAverages[cellIndex]!, state.quadratureAverages[cellIndex]!);
  }
  state.phaseDisplayMaximum = smoothDisplayMaximum(
    state.phaseDisplayMaximum,
    displayTargetFromStatistics(robustAmplitudeStatistics(amplitudes, cellCount)),
    stepSeconds,
  );
  const inverseMaximum = 1 / state.phaseDisplayMaximum;
  const degreesPerRadian = phaseTableSize / (2 * Math.PI);
  for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
    const relativeAmplitude = Math.min(1, amplitudes[cellIndex]! * inverseMaximum);
    const outputOffset = cellIndex * 4;
    const rootMeanSquare = Math.sqrt(state.meanSquares[cellIndex]!);
    const coherence = rootMeanSquare > 0 ? amplitudes[cellIndex]! / (Math.SQRT2 * rootMeanSquare) : 0;
    const opacity = smoothStep(0.35, 0.7, coherence) * smoothStep(0.05, 0.3, relativeAmplitude);
    if (opacity <= 0) {
      outputRgba[outputOffset + 3] = 0;
      continue;
    }
    const cellPhase = Math.atan2(-state.quadratureAverages[cellIndex]!, state.inPhaseAverages[cellIndex]!);
    const relativePhase = cellPhase - referencePhase;
    const tableIndex = ((Math.round(relativePhase * degreesPerRadian) % phaseTableSize) + phaseTableSize) % phaseTableSize;
    // Las celdas débiles, algo más oscuras: el color «brilla» donde hay más movimiento.
    const brightness = 0.55 + 0.45 * relativeAmplitude;
    outputRgba[outputOffset] = Math.round(phaseColorTable[tableIndex * 3]! * brightness);
    outputRgba[outputOffset + 1] = Math.round(phaseColorTable[tableIndex * 3 + 1]! * brightness);
    outputRgba[outputOffset + 2] = Math.round(phaseColorTable[tableIndex * 3 + 2]! * brightness);
    outputRgba[outputOffset + 3] = Math.round(maximumMapAlpha * opacity);
  }
  return true;
}
