/**
 * Analizador del parpadeo de la luz con el obturador rodante de la cámara.
 *
 * Por cada fotograma llegan dos perfiles de luminancia (media por fila y por columna) y su marca
 * de tiempo. Cada cierto tiempo, `analyze()`:
 *  1. Quita la escena: divide cada perfil por la media de los últimos fotogramas (las bandas se
 *     desplazan de un fotograma a otro y se promedian; la escena, quieta, no). Si las bandas no
 *     se mueven (cadencia múltiplo del parpadeo), usa el perfil con un fondo polinómico.
 *  2. Busca con la FFT la frecuencia espacial de las bandas en los dos ejes y los dos modos y se
 *     queda con el pico más claro; la afina ajustando senoidales.
 *  3. Ajusta en cada fotograma fondo + 3 armónicos: amplitudes (profundidad y forma de la onda)
 *     y fase en la fila central.
 *  4. Con la deriva de esa fase entre fotogramas y sus marcas de tiempo, estima la frecuencia
 *     absoluta del parpadeo (ver phaseDrift.ts), sin necesidad de conocer el tiempo por fila.
 */

import { createFftPlan, fftInPlace, type FftPlan } from '@/processing/dsp/fft';
import { createWindow } from '@/processing/dsp/windows';

import { type BandFit, createBandFitter, evaluateBandModel, removeFittedBackground, solveLinearSystem } from './bandFit';
import { classifyLight, computeFlickerMetrics, type FlickerMetrics, type LightType } from './lightClassification';
import {
  defaultPhaseDriftOptions,
  estimateFlickerFrequency,
  type FlickerFrequencyEstimate,
  type PhaseSample,
  wrapAngle,
} from './phaseDrift';

export type ProfileAxis = 'rows' | 'columns';
/** `temporal`: escena quitada con la media de fotogramas. `spatial`: fondo polinómico. */
export type SceneRemovalMode = 'temporal' | 'spatial';

export interface FlickerFrameProfiles {
  timestampSeconds: number;
  rowProfile: Float64Array;
  columnProfile: Float64Array;
  saturatedFraction: number;
}

export interface FlickerAnalyzerOptions {
  /** Frecuencia nominal del parpadeo: el doble de la de la red (100 Hz en Europa). */
  nominalFlickerFrequencyHz: number;
  /** Fotogramas recientes con los que se buscan las bandas y se quita la escena. */
  windowFrameCount: number;
  /** Fotogramas mínimos antes de buscar bandas. */
  minimumFrameCount: number;
  /** Historial de fases para la frecuencia (más largo = más preciso, pero más lento de calcular). */
  maximumHistorySeconds: number;
  /** Relación pico/ruido mínima en el espectro espacial para dar por detectadas las bandas. */
  minimumSignalToNoise: number;
  /** Mínimo de ciclos de banda por fotograma que se buscan (por debajo se confunden con el fondo). */
  minimumCyclesPerFrame: number;
  /** Máxima frecuencia espacial buscada, en ciclos por muestra del perfil. */
  maximumSpatialFrequency: number;
  /** Duración mínima del historial de fases para dar una frecuencia. */
  minimumFrequencySeconds: number;
  /** Coherencia de fase mínima para dar la frecuencia por buena. */
  minimumPhaseCoherence: number;
  harmonicCount: number;
}

export const defaultFlickerAnalyzerOptions: Omit<FlickerAnalyzerOptions, 'nominalFlickerFrequencyHz'> = {
  windowFrameCount: 32,
  minimumFrameCount: 12,
  maximumHistorySeconds: 30,
  minimumSignalToNoise: 12,
  minimumCyclesPerFrame: 0.9,
  maximumSpatialFrequency: 0.2,
  minimumFrequencySeconds: 2,
  minimumPhaseCoherence: 0.5,
  harmonicCount: 3,
};

export interface BandDetection {
  axis: ProfileAxis;
  mode: SceneRemovalMode;
  /** Ciclos por muestra del perfil. */
  spatialFrequency: number;
  /** Bandas (ciclos de parpadeo) a lo largo de todo el fotograma. */
  cyclesPerFrame: number;
  signalToNoise: number;
}

export type FlickerAnalysisStatus = 'collecting' | 'noBands' | 'bands';

export interface FlickerAnalysis {
  status: FlickerAnalysisStatus;
  /** Cadencia real de los fotogramas analizados. */
  frameRateHz: number | null;
  saturatedFraction: number;
  detection: BandDetection | null;
  /** Métricas de la onda (null sin bandas). */
  metrics: FlickerMetrics | null;
  /** Sin bandas: profundidad máxima compatible con lo medido, en % (cota superior). */
  percentFlickerUpperBound: number | null;
  lightType: LightType | null;
  /** Frecuencia del parpadeo (null mientras no hay bastante historial coherente). */
  frequency: FlickerFrequencyEstimate | null;
  /** Segundos de historial de fases acumulados. */
  phaseHistorySeconds: number;
  /** Tiempo que tarda el sensor en leer el fotograma entero en el eje de las bandas, en ms. */
  readoutTimeMilliseconds: number | null;
  /** Último perfil sin fondo (relativo, 0,01 = 1 %) y bandas ajustadas, para dibujar. */
  latestModulationProfile: Float64Array | null;
  latestFittedBands: Float64Array | null;
}

interface CandidateConfiguration {
  axis: ProfileAxis;
  mode: SceneRemovalMode;
  spatialFrequency: number;
  signalToNoise: number;
}

function nextPowerOfTwo(minimumValue: number): number {
  let powerOfTwo = 1;
  while (powerOfTwo < minimumValue) powerOfTwo *= 2;
  return powerOfTwo;
}

function backgroundDegreeForMode(mode: SceneRemovalMode): number {
  return mode === 'temporal' ? 1 : 2;
}

/** Resta el polinomio de grado `degree` ajustado por mínimos cuadrados. */
export function subtractPolynomialTrend(values: ArrayLike<number>, degree: number): Float64Array {
  const valueCount = values.length;
  const parameterCount = degree + 1;
  const normalMatrix = new Float64Array(parameterCount * parameterCount);
  const normalRightHandSide = new Float64Array(parameterCount);
  const powers = new Float64Array(parameterCount);
  const fillPowers = (sampleIndex: number) => {
    const normalizedPosition = (sampleIndex - (valueCount - 1) / 2) / (valueCount / 2);
    let powerValue = 1;
    for (let powerIndex = 0; powerIndex < parameterCount; powerIndex++) {
      powers[powerIndex] = powerValue;
      powerValue *= normalizedPosition;
    }
  };
  for (let sampleIndex = 0; sampleIndex < valueCount; sampleIndex++) {
    fillPowers(sampleIndex);
    for (let rowIndex = 0; rowIndex < parameterCount; rowIndex++) {
      normalRightHandSide[rowIndex] = normalRightHandSide[rowIndex]! + powers[rowIndex]! * values[sampleIndex]!;
      for (let columnIndex = 0; columnIndex < parameterCount; columnIndex++) {
        normalMatrix[rowIndex * parameterCount + columnIndex] =
          normalMatrix[rowIndex * parameterCount + columnIndex]! + powers[rowIndex]! * powers[columnIndex]!;
      }
    }
  }
  const coefficients = solveLinearSystem(normalMatrix, normalRightHandSide, parameterCount);
  const detrendedValues = new Float64Array(valueCount);
  for (let sampleIndex = 0; sampleIndex < valueCount; sampleIndex++) {
    fillPowers(sampleIndex);
    let trendValue = 0;
    if (coefficients) {
      for (let powerIndex = 0; powerIndex < parameterCount; powerIndex++) {
        trendValue += coefficients[powerIndex]! * powers[powerIndex]!;
      }
    }
    detrendedValues[sampleIndex] = values[sampleIndex]! - trendValue;
  }
  return detrendedValues;
}

interface SpectralPeak {
  spatialFrequency: number;
  signalToNoise: number;
}

/**
 * Espectro de potencia medio de varios perfiles (sin tendencia, con ventana de Hann y relleno de
 * ceros) y su pico más alto entre `minimumSpatialFrequency` y `maximumSpatialFrequency`. La
 * relación señal/ruido es la potencia del pico entre la mediana de la banda de búsqueda.
 */
export function findSpatialSpectralPeak(
  profiles: readonly ArrayLike<number>[],
  backgroundDegree: number,
  minimumSpatialFrequency: number,
  maximumSpatialFrequency: number,
  fftPlanCache: Map<number, FftPlan>,
): SpectralPeak | null {
  const firstProfile = profiles[0];
  if (!firstProfile) return null;
  const profileLength = firstProfile.length;
  const fftSize = nextPowerOfTwo(Math.max(1024, 2 * profileLength));
  let fftPlan = fftPlanCache.get(fftSize);
  if (!fftPlan) {
    fftPlan = createFftPlan(fftSize);
    fftPlanCache.set(fftSize, fftPlan);
  }
  const hannWindow = createWindow('hann', profileLength).coefficients;
  const averagedPower = new Float64Array(fftSize / 2);
  const realPart = new Float64Array(fftSize);
  const imaginaryPart = new Float64Array(fftSize);
  for (const profile of profiles) {
    const detrendedProfile = subtractPolynomialTrend(profile, backgroundDegree);
    realPart.fill(0);
    imaginaryPart.fill(0);
    for (let sampleIndex = 0; sampleIndex < profileLength; sampleIndex++) {
      realPart[sampleIndex] = detrendedProfile[sampleIndex]! * hannWindow[sampleIndex]!;
    }
    fftInPlace(fftPlan, realPart, imaginaryPart);
    for (let binIndex = 0; binIndex < fftSize / 2; binIndex++) {
      averagedPower[binIndex] = averagedPower[binIndex]! + realPart[binIndex]! ** 2 + imaginaryPart[binIndex]! ** 2;
    }
  }
  const firstBin = Math.max(1, Math.ceil(minimumSpatialFrequency * fftSize));
  const lastBin = Math.min(fftSize / 2 - 2, Math.floor(maximumSpatialFrequency * fftSize));
  if (lastBin <= firstBin + 2) return null;
  let peakBin = firstBin;
  const bandPowers: number[] = [];
  for (let binIndex = firstBin; binIndex <= lastBin; binIndex++) {
    bandPowers.push(averagedPower[binIndex]!);
    if (averagedPower[binIndex]! > averagedPower[peakBin]!) peakBin = binIndex;
  }
  bandPowers.sort((firstPower, secondPower) => firstPower - secondPower);
  const medianPower = bandPowers[Math.floor(bandPowers.length / 2)]!;
  // Interpolación parabólica del pico (en logaritmo, más fiel para ventanas de Hann).
  const leftPower = Math.log(averagedPower[peakBin - 1]! + 1e-300);
  const centerPower = Math.log(averagedPower[peakBin]! + 1e-300);
  const rightPower = Math.log(averagedPower[peakBin + 1]! + 1e-300);
  const curvature = leftPower - 2 * centerPower + rightPower;
  const binOffset = curvature < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (leftPower - rightPower)) / curvature)) : 0;
  return {
    spatialFrequency: (peakBin + binOffset) / fftSize,
    signalToNoise: medianPower > 0 ? averagedPower[peakBin]! / medianPower : Number.POSITIVE_INFINITY,
  };
}

/** Suma de las potencias de la fundamental ajustada en todos los perfiles. */
function totalFundamentalPower(profiles: readonly ArrayLike<number>[], spatialFrequency: number, backgroundDegree: number) {
  const firstProfile = profiles[0];
  if (!firstProfile) return 0;
  const bandFitter = createBandFitter(firstProfile.length, { spatialFrequency, harmonicCount: 1, backgroundDegree });
  if (!bandFitter) return 0;
  let powerSum = 0;
  for (const profile of profiles) {
    const bandFit = bandFitter.fit(profile);
    if (bandFit) powerSum += bandFit.relativeAmplitudes[0]! ** 2;
  }
  return powerSum;
}

/**
 * Afina la frecuencia espacial maximizando la potencia ajustada (búsqueda de sección áurea).
 * Con pocos ciclos por fotograma, el pico de la FFT está sesgado; el ajuste directo no.
 */
export function refineSpatialFrequency(
  profiles: readonly ArrayLike<number>[],
  initialSpatialFrequency: number,
  backgroundDegree: number,
  lowerLimit: number,
  upperLimit: number,
): number {
  const goldenRatioFraction = (Math.sqrt(5) - 1) / 2;
  let lowerBound = Math.max(lowerLimit, initialSpatialFrequency * 0.75);
  let upperBound = Math.min(upperLimit, initialSpatialFrequency * 1.25);
  if (!(upperBound > lowerBound)) return initialSpatialFrequency;
  let lowerProbe = upperBound - goldenRatioFraction * (upperBound - lowerBound);
  let upperProbe = lowerBound + goldenRatioFraction * (upperBound - lowerBound);
  let lowerProbePower = totalFundamentalPower(profiles, lowerProbe, backgroundDegree);
  let upperProbePower = totalFundamentalPower(profiles, upperProbe, backgroundDegree);
  for (let iteration = 0; iteration < 18; iteration++) {
    if (lowerProbePower > upperProbePower) {
      upperBound = upperProbe;
      upperProbe = lowerProbe;
      upperProbePower = lowerProbePower;
      lowerProbe = upperBound - goldenRatioFraction * (upperBound - lowerBound);
      lowerProbePower = totalFundamentalPower(profiles, lowerProbe, backgroundDegree);
    } else {
      lowerBound = lowerProbe;
      lowerProbe = upperProbe;
      lowerProbePower = upperProbePower;
      upperProbe = lowerBound + goldenRatioFraction * (upperBound - lowerBound);
      upperProbePower = totalFundamentalPower(profiles, upperProbe, backgroundDegree);
    }
  }
  return (lowerBound + upperBound) / 2;
}

function normalizeProfile(profile: Float64Array): Float64Array {
  let valueSum = 0;
  for (const profileValue of profile) valueSum += profileValue;
  const meanValue = valueSum / profile.length;
  const normalizedProfile = new Float64Array(profile.length);
  if (!(meanValue > 0)) return normalizedProfile;
  for (let sampleIndex = 0; sampleIndex < profile.length; sampleIndex++) {
    normalizedProfile[sampleIndex] = profile[sampleIndex]! / meanValue;
  }
  return normalizedProfile;
}

function averageProfiles(profiles: readonly Float64Array[]): Float64Array {
  const averagedProfile = new Float64Array(profiles[0]!.length);
  for (const profile of profiles) {
    for (let sampleIndex = 0; sampleIndex < profile.length; sampleIndex++) {
      averagedProfile[sampleIndex] = averagedProfile[sampleIndex]! + profile[sampleIndex]!;
    }
  }
  for (let sampleIndex = 0; sampleIndex < averagedProfile.length; sampleIndex++) {
    averagedProfile[sampleIndex] = averagedProfile[sampleIndex]! / profiles.length;
  }
  return averagedProfile;
}

function divideProfiles(numeratorProfile: Float64Array, denominatorProfile: Float64Array): Float64Array {
  const quotientProfile = new Float64Array(numeratorProfile.length);
  for (let sampleIndex = 0; sampleIndex < numeratorProfile.length; sampleIndex++) {
    const denominatorValue = denominatorProfile[sampleIndex]!;
    quotientProfile[sampleIndex] = denominatorValue > 0 ? numeratorProfile[sampleIndex]! / denominatorValue : 1;
  }
  return quotientProfile;
}

/** Perfiles sin escena para un modo: cocientes con la media temporal o los normalizados tal cual. */
function sceneRemovedProfiles(normalizedProfiles: readonly Float64Array[], mode: SceneRemovalMode): Float64Array[] {
  if (mode === 'spatial') return [...normalizedProfiles];
  const temporalReference = averageProfiles(normalizedProfiles);
  return normalizedProfiles.map((normalizedProfile) => divideProfiles(normalizedProfile, temporalReference));
}

/**
 * Referencia temporal corregida: la media de los perfiles con sus bandas ajustadas ya quitadas.
 * Si las bandas se movían poco entre fotogramas, la media simple las conservaba en parte y
 * atenuaba la modulación medida; así se corrige.
 */
function refinedTemporalProfiles(
  normalizedProfiles: readonly Float64Array[],
  bandFits: readonly (BandFit | null)[],
  spatialFrequency: number,
): Float64Array[] {
  const profileLength = normalizedProfiles[0]!.length;
  const bandFreeProfiles = normalizedProfiles.map((normalizedProfile, profileIndex) => {
    const bandFit = bandFits[profileIndex];
    if (!bandFit) return normalizedProfile;
    const bandValues = evaluateBandModel(bandFit, spatialFrequency, profileLength);
    const bandFreeProfile = new Float64Array(profileLength);
    for (let sampleIndex = 0; sampleIndex < profileLength; sampleIndex++) {
      bandFreeProfile[sampleIndex] = normalizedProfile[sampleIndex]! / Math.max(0.05, 1 + bandValues[sampleIndex]!);
    }
    return bandFreeProfile;
  });
  const refinedReference = averageProfiles(bandFreeProfiles);
  return normalizedProfiles.map((normalizedProfile) => divideProfiles(normalizedProfile, refinedReference));
}

function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sortedValues = [...values].sort((firstValue, secondValue) => firstValue - secondValue);
  return sortedValues[Math.floor(sortedValues.length / 2)]!;
}

/** Media vectorial de los armónicos, con las fases relativas a la fundamental (k·φ₁). */
function averageHarmonics(bandFits: readonly BandFit[]): { relativeAmplitudes: number[]; phases: number[] } {
  const harmonicCount = Math.min(...bandFits.map((bandFit) => bandFit.relativeAmplitudes.length));
  const relativeAmplitudes: number[] = [];
  const phases: number[] = [];
  for (let harmonicIndex = 0; harmonicIndex < harmonicCount; harmonicIndex++) {
    if (harmonicIndex === 0) {
      let amplitudeSum = 0;
      for (const bandFit of bandFits) amplitudeSum += bandFit.relativeAmplitudes[0]!;
      relativeAmplitudes.push(amplitudeSum / bandFits.length);
      phases.push(0);
      continue;
    }
    let realSum = 0;
    let imaginarySum = 0;
    for (const bandFit of bandFits) {
      const relativePhase = bandFit.phases[harmonicIndex]! - (harmonicIndex + 1) * bandFit.phases[0]!;
      realSum += bandFit.relativeAmplitudes[harmonicIndex]! * Math.cos(relativePhase);
      imaginarySum += bandFit.relativeAmplitudes[harmonicIndex]! * Math.sin(relativePhase);
    }
    relativeAmplitudes.push(Math.hypot(realSum, imaginarySum) / bandFits.length);
    phases.push(Math.atan2(imaginarySum, realSum));
  }
  return { relativeAmplitudes, phases };
}

const profileAxes: readonly ProfileAxis[] = ['rows', 'columns'];
/**
 * Por debajo de este giro de fase por fotograma (radianes), las bandas casi no se mueven y la
 * media temporal no las separa de la escena: solo entonces se usa el modo espacial, que puede
 * confundir con bandas lo que sea periódico en la escena.
 */
const staticBandPhaseStepRadians = 0.6;

/** Modos de quitar la escena que tienen sentido con esta cadencia y este parpadeo nominal. */
export function usableSceneRemovalModes(
  frameRateHz: number | null,
  nominalFlickerFrequencyHz: number,
): SceneRemovalMode[] {
  if (!frameRateHz) return ['temporal'];
  const phaseStepPerFrame = wrapAngle((2 * Math.PI * nominalFlickerFrequencyHz) / frameRateHz);
  return Math.abs(phaseStepPerFrame) < staticBandPhaseStepRadians ? ['temporal', 'spatial'] : ['temporal'];
}
/** Una configuración nueva sustituye a la fijada solo si su pico es claramente mejor. */
const configurationSwitchFactor = 2;
/** Peso máximo de un fotograma en el ajuste de fases (evita que uno domine). */
const maximumPhaseWeight = 1e4;

export function createFlickerAnalyzer(analyzerOptions: Partial<FlickerAnalyzerOptions> & { nominalFlickerFrequencyHz: number }) {
  const options: FlickerAnalyzerOptions = { ...defaultFlickerAnalyzerOptions, ...analyzerOptions };
  const recentFrames: FlickerFrameProfiles[] = [];
  const fftPlanCache = new Map<number, FftPlan>();
  let lockedConfiguration: CandidateConfiguration | null = null;
  let phaseHistory: PhaseSample[] = [];
  let lastPhaseTimestamp = Number.NEGATIVE_INFINITY;

  function reset() {
    recentFrames.length = 0;
    lockedConfiguration = null;
    phaseHistory = [];
    lastPhaseTimestamp = Number.NEGATIVE_INFINITY;
  }

  function pushFrame(frameProfiles: FlickerFrameProfiles) {
    const previousFrame = recentFrames[recentFrames.length - 1];
    if (previousFrame) {
      const hasSameShape =
        previousFrame.rowProfile.length === frameProfiles.rowProfile.length &&
        previousFrame.columnProfile.length === frameProfiles.columnProfile.length;
      // Si cambia la resolución, lo anterior ya no vale. Si el tiempo retrocede, se descarta.
      if (!hasSameShape) reset();
      else if (!(frameProfiles.timestampSeconds > previousFrame.timestampSeconds)) return;
    }
    recentFrames.push(frameProfiles);
    if (recentFrames.length > options.windowFrameCount) recentFrames.shift();
  }

  function searchCandidates(
    normalizedProfilesByAxis: Record<ProfileAxis, Float64Array[]>,
    sceneRemovalModes: readonly SceneRemovalMode[],
  ): CandidateConfiguration[] {
    const candidates: CandidateConfiguration[] = [];
    for (const axis of profileAxes) {
      const normalizedProfiles = normalizedProfilesByAxis[axis];
      const profileLength = normalizedProfiles[0]!.length;
      const minimumSpatialFrequency = options.minimumCyclesPerFrame / profileLength;
      for (const mode of sceneRemovalModes) {
        // En modo espacial no hay movimiento que distinga bandas de escena: solo se buscan en
        // las filas del búfer (la orientación nativa del sensor, en la que lee el obturador).
        if (mode === 'spatial' && axis !== 'rows') continue;
        const spectralPeak = findSpatialSpectralPeak(
          sceneRemovedProfiles(normalizedProfiles, mode),
          backgroundDegreeForMode(mode),
          minimumSpatialFrequency,
          options.maximumSpatialFrequency,
          fftPlanCache,
        );
        if (spectralPeak) candidates.push({ axis, mode, ...spectralPeak });
      }
    }
    return candidates;
  }

  function chooseConfiguration(candidates: CandidateConfiguration[]): CandidateConfiguration | null {
    const bestCandidate = candidates.reduce<CandidateConfiguration | null>(
      (currentBest, candidate) =>
        !currentBest || candidate.signalToNoise > currentBest.signalToNoise ? candidate : currentBest,
      null,
    );
    const lockedCandidate = lockedConfiguration
      ? candidates.find(
          (candidate) => candidate.axis === lockedConfiguration!.axis && candidate.mode === lockedConfiguration!.mode,
        )
      : undefined;
    if (
      lockedCandidate &&
      lockedCandidate.signalToNoise >= options.minimumSignalToNoise &&
      (!bestCandidate || bestCandidate.signalToNoise < configurationSwitchFactor * lockedCandidate.signalToNoise)
    ) {
      return lockedCandidate;
    }
    if (bestCandidate && bestCandidate.signalToNoise >= options.minimumSignalToNoise) return bestCandidate;
    return null;
  }

  function analyze(): FlickerAnalysis {
    const frameIntervals: number[] = [];
    for (let frameIndex = 1; frameIndex < recentFrames.length; frameIndex++) {
      frameIntervals.push(recentFrames[frameIndex]!.timestampSeconds - recentFrames[frameIndex - 1]!.timestampSeconds);
    }
    const medianFrameInterval = medianOf(frameIntervals);
    const frameRateHz = medianFrameInterval && medianFrameInterval > 0 ? 1 / medianFrameInterval : null;
    const saturatedFraction =
      recentFrames.length > 0
        ? recentFrames.reduce((fractionSum, frame) => fractionSum + frame.saturatedFraction, 0) / recentFrames.length
        : 0;
    const phaseHistorySeconds =
      phaseHistory.length > 1 ? phaseHistory[phaseHistory.length - 1]!.timeSeconds - phaseHistory[0]!.timeSeconds : 0;
    const emptyAnalysis: FlickerAnalysis = {
      status: 'collecting',
      frameRateHz,
      saturatedFraction,
      detection: null,
      metrics: null,
      percentFlickerUpperBound: null,
      lightType: null,
      frequency: null,
      phaseHistorySeconds,
      readoutTimeMilliseconds: null,
      latestModulationProfile: null,
      latestFittedBands: null,
    };
    if (recentFrames.length < options.minimumFrameCount) return emptyAnalysis;

    const normalizedProfilesByAxis: Record<ProfileAxis, Float64Array[]> = {
      rows: recentFrames.map((frame) => normalizeProfile(frame.rowProfile)),
      columns: recentFrames.map((frame) => normalizeProfile(frame.columnProfile)),
    };
    const candidates = searchCandidates(
      normalizedProfilesByAxis,
      usableSceneRemovalModes(frameRateHz, options.nominalFlickerFrequencyHz),
    );
    const chosenCandidate = chooseConfiguration(candidates);

    if (!chosenCandidate) {
      // Sin bandas: la profundidad máxima compatible es la amplitud ajustada en el mejor pico.
      let percentFlickerUpperBound = 0;
      for (const candidate of candidates) {
        const scenelessProfiles = sceneRemovedProfiles(normalizedProfilesByAxis[candidate.axis], candidate.mode);
        const meanPower =
          totalFundamentalPower(scenelessProfiles, candidate.spatialFrequency, backgroundDegreeForMode(candidate.mode)) /
          scenelessProfiles.length;
        percentFlickerUpperBound = Math.max(percentFlickerUpperBound, 100 * Math.sqrt(meanPower));
      }
      return {
        ...emptyAnalysis,
        status: 'noBands',
        percentFlickerUpperBound,
        lightType: 'steady',
        frequency: currentFrequencyEstimate(),
      };
    }

    const normalizedProfiles = normalizedProfilesByAxis[chosenCandidate.axis];
    const profileLength = normalizedProfiles[0]!.length;
    const backgroundDegree = backgroundDegreeForMode(chosenCandidate.mode);
    const spatialFrequency = refineSpatialFrequency(
      sceneRemovedProfiles(normalizedProfiles, chosenCandidate.mode),
      chosenCandidate.spatialFrequency,
      backgroundDegree,
      options.minimumCyclesPerFrame / profileLength,
      options.maximumSpatialFrequency,
    );
    const isConfigurationChange =
      !lockedConfiguration ||
      lockedConfiguration.axis !== chosenCandidate.axis ||
      lockedConfiguration.mode !== chosenCandidate.mode;
    if (isConfigurationChange) {
      // Otro eje u otro modo: las fases anteriores no son comparables.
      phaseHistory = [];
      lastPhaseTimestamp = Number.NEGATIVE_INFINITY;
    }
    lockedConfiguration = { ...chosenCandidate, spatialFrequency };

    const bandFitter = createBandFitter(profileLength, {
      spatialFrequency,
      harmonicCount: options.harmonicCount,
      backgroundDegree,
    });
    let scenelessProfiles = sceneRemovedProfiles(normalizedProfiles, chosenCandidate.mode);
    let bandFits = scenelessProfiles.map((profile) => bandFitter?.fit(profile) ?? null);
    if (chosenCandidate.mode === 'temporal') {
      scenelessProfiles = refinedTemporalProfiles(normalizedProfiles, bandFits, spatialFrequency);
      bandFits = scenelessProfiles.map((profile) => bandFitter?.fit(profile) ?? null);
    }

    // Fases de los fotogramas nuevos al historial.
    recentFrames.forEach((frame, frameIndex) => {
      const bandFit = bandFits[frameIndex];
      if (!bandFit || frame.timestampSeconds <= lastPhaseTimestamp) return;
      const phaseSignalToNoise = bandFit.relativeAmplitudes[0]! / Math.max(1e-6, bandFit.relativeResidualRms);
      phaseHistory.push({
        timeSeconds: frame.timestampSeconds,
        phaseRadians: bandFit.phases[0]!,
        weight: Math.min(maximumPhaseWeight, phaseSignalToNoise ** 2),
      });
      lastPhaseTimestamp = frame.timestampSeconds;
    });
    const newestPhaseTime = phaseHistory[phaseHistory.length - 1]?.timeSeconds ?? 0;
    phaseHistory = phaseHistory.filter(
      (phaseSample) => newestPhaseTime - phaseSample.timeSeconds <= options.maximumHistorySeconds,
    );

    const validBandFits = bandFits.filter((bandFit): bandFit is BandFit => bandFit !== null);
    const metrics =
      validBandFits.length > 0
        ? (() => {
            const { relativeAmplitudes, phases } = averageHarmonics(validBandFits);
            return computeFlickerMetrics(relativeAmplitudes, phases);
          })()
        : null;
    const frequency = currentFrequencyEstimate();
    const cyclesPerFrame = spatialFrequency * profileLength;
    const flickerFrequencyForReadout = frequency?.flickerFrequencyHz ?? options.nominalFlickerFrequencyHz;

    const latestProfile = scenelessProfiles[scenelessProfiles.length - 1]!;
    const latestFit = bandFits[bandFits.length - 1] ?? null;
    return {
      ...emptyAnalysis,
      status: 'bands',
      phaseHistorySeconds:
        phaseHistory.length > 1 ? phaseHistory[phaseHistory.length - 1]!.timeSeconds - phaseHistory[0]!.timeSeconds : 0,
      detection: {
        axis: chosenCandidate.axis,
        mode: chosenCandidate.mode,
        spatialFrequency,
        cyclesPerFrame,
        signalToNoise: chosenCandidate.signalToNoise,
      },
      metrics,
      lightType: classifyLight(metrics),
      frequency,
      readoutTimeMilliseconds: (1000 * cyclesPerFrame) / flickerFrequencyForReadout,
      latestModulationProfile: latestFit ? removeFittedBackground(latestProfile, latestFit) : null,
      latestFittedBands: latestFit ? evaluateBandModel(latestFit, spatialFrequency, profileLength) : null,
    };
  }

  function currentFrequencyEstimate(): FlickerFrequencyEstimate | null {
    if (phaseHistory.length < 3) return null;
    const historySeconds = phaseHistory[phaseHistory.length - 1]!.timeSeconds - phaseHistory[0]!.timeSeconds;
    if (historySeconds < options.minimumFrequencySeconds) return null;
    const estimate = estimateFlickerFrequency(phaseHistory, {
      ...defaultPhaseDriftOptions,
      nominalFlickerFrequencyHz: options.nominalFlickerFrequencyHz,
    });
    if (!estimate || estimate.phaseCoherence < options.minimumPhaseCoherence) return null;
    return estimate;
  }

  return { pushFrame, analyze, reset };
}

export type FlickerAnalyzer = ReturnType<typeof createFlickerAnalyzer>;
