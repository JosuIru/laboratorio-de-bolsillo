/**
 * Vigilancia de meteoros («estrellas fugaces») con fotogramas seguidos de la cámara quieta.
 *
 * Un meteoro cruza el campo en una fracción de segundo: aparece como un segmento recto y
 * brillante en UN fotograma (dos, como mucho) y ya no está en los siguientes. Por fotograma:
 *
 *  1. Fondo: mediana por píxel de los K fotogramas anteriores. Las estrellas, el paisaje y los
 *     píxeles calientes (fijos) están en la mediana y desaparecen en la diferencia; un meteoro
 *     de un solo fotograma no mueve la mediana.
 *  2. Diferencia con el fondo y umbral a `thresholdSigmas` veces su ruido (MAD).
 *  3. Se quitan los píxeles aislados (el centelleo y el ruido dan píxeles sueltos; un meteoro,
 *     una línea continua). Si cambia mucho la imagen (nube, faros, cambio de exposición), el
 *     fotograma se salta.
 *  4. Transformada de Hough (ρ = x·cos θ + y·sen θ) de los píxeles que cambian; la recta más
 *     votada se recorta al tramo continuo más largo de sus píxeles y se acepta si es larga y
 *     está bastante llena. Se repite para encontrar varias.
 *  5. Confirmación temporal: se espera `neighbourFrameCount` fotogramas. Un satélite o un avión
 *     se mueve despacio: deja rastro (segmentos o puntos) sobre la misma recta en varios
 *     fotogramas seguidos y se descarta. Un meteoro no (se admite uno vecino: los que duran algo
 *     más caen en dos fotogramas).
 *
 * Módulo puro: sin React ni React Native.
 */

export interface MeteorDetectionOptions {
  /** Fotogramas anteriores cuya mediana es el fondo (impar, 3-9). */
  backgroundFrameCount: number;
  /** Umbral de la diferencia, en σ de su ruido. */
  thresholdSigmas: number;
  /** Longitud mínima del segmento, en píxeles. */
  minimumSegmentLengthPixels: number;
  /** Fracción mínima del segmento cubierta por píxeles que cambian. */
  minimumCoverage: number;
  /** Distancia máxima de un píxel a la recta para contarlo en ella. */
  lineTolerancePixels: number;
  /** Hueco máximo dentro de un segmento. */
  maximumGapPixels: number;
  /** Si cambia más de esta fracción de la imagen, el fotograma se salta. */
  maximumChangedFraction: number;
  /** Fotogramas antes y después que se miran para descartar objetos lentos. */
  neighbourFrameCount: number;
  /** Fotogramas vecinos con rastro en la misma recta a partir de los cuales es un objeto lento. */
  slowMoverNeighbourCount: number;
  maximumSegmentsPerFrame: number;
}

export const defaultMeteorDetectionOptions: MeteorDetectionOptions = {
  backgroundFrameCount: 5,
  thresholdSigmas: 5,
  minimumSegmentLengthPixels: 15,
  minimumCoverage: 0.5,
  lineTolerancePixels: 1.5,
  maximumGapPixels: 5,
  maximumChangedFraction: 0.02,
  neighbourFrameCount: 2,
  slowMoverNeighbourCount: 2,
  maximumSegmentsPerFrame: 3,
};

export interface LineSegment {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  lengthPixels: number;
  pixelCount: number;
  /** Fracción del segmento con píxeles que cambian. */
  coverage: number;
  /** Mayor exceso sobre el fondo de sus píxeles. */
  peakExcess: number;
}

/** Algo que ha cambiado en un fotograma: un segmento o una mancha (su centro). */
interface ChangeFeature {
  centerX: number;
  centerY: number;
}

export interface MeteorEvent {
  frameIndex: number;
  timestampMilliseconds: number;
  segment: LineSegment;
  /** Copia del fotograma del evento (luminancia de 8 bits). */
  frameBytes: Uint8Array;
  width: number;
  height: number;
}

export interface MeteorFrameAnalysis {
  isWarmingUp: boolean;
  /** Cambió demasiado la imagen y no se buscó nada. */
  wasSkippedAsGlobalChange: boolean;
  changedPixelCount: number;
  noiseSigma: number;
  segments: LineSegment[];
  features: ChangeFeature[];
}

interface PendingCandidate {
  frameIndex: number;
  timestampMilliseconds: number;
  segment: LineSegment;
  frameBytes: Uint8Array;
}

interface FrameHistoryEntry {
  frameIndex: number;
  features: ChangeFeature[];
}

export interface MeteorWatchStatistics {
  processedFrameCount: number;
  skippedFrameCount: number;
  meteorCount: number;
  rejectedSlowMoverCount: number;
  /** Desde el primer fotograma analizado (tras calentar) hasta el último. */
  watchedMilliseconds: number;
}

// ---------------------------------------------------------------------------------------------
// Piezas
// ---------------------------------------------------------------------------------------------

/** Mediana por píxel de varios fotogramas (pocos: ordenación por inserción). */
export function medianOfFrames(frames: readonly Uint8Array[], output?: Uint8Array): Uint8Array {
  const frameCount = frames.length;
  const pixelCount = frames[0]?.length ?? 0;
  const medianBytes = output ?? new Uint8Array(pixelCount);
  const pixelValues = new Uint8Array(frameCount);
  const middleIndex = frameCount >> 1;
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
      const value = frames[frameIndex]![pixelIndex]!;
      let insertIndex = frameIndex;
      while (insertIndex > 0 && pixelValues[insertIndex - 1]! > value) {
        pixelValues[insertIndex] = pixelValues[insertIndex - 1]!;
        insertIndex--;
      }
      pixelValues[insertIndex] = value;
    }
    medianBytes[pixelIndex] = pixelValues[middleIndex]!;
  }
  return medianBytes;
}

/** σ robusta (MAD) de la diferencia, con una muestra. */
function robustDifferenceSigma(frameBytes: Uint8Array, backgroundBytes: Uint8Array): number {
  const sampleStride = Math.max(1, Math.floor(frameBytes.length / 20_000));
  const differences: number[] = [];
  for (let pixelIndex = 0; pixelIndex < frameBytes.length; pixelIndex += sampleStride) {
    differences.push(frameBytes[pixelIndex]! - backgroundBytes[pixelIndex]!);
  }
  differences.sort((first, second) => first - second);
  const median = differences[differences.length >> 1] ?? 0;
  const absoluteDeviations = differences.map((difference) => Math.abs(difference - median)).sort((first, second) => first - second);
  const madSigma = 1.4826 * (absoluteDeviations[absoluteDeviations.length >> 1] ?? 0);
  if (madSigma > 0) return madSigma;
  // Con 8 bits y poco ruido la MAD puede ser 0: desviación típica.
  let squaredSum = 0;
  for (const difference of differences) squaredSum += (difference - median) ** 2;
  return Math.sqrt(squaredSum / Math.max(1, differences.length - 1));
}

interface ChangedPixels {
  xs: Int32Array;
  ys: Int32Array;
  excesses: Float32Array;
  count: number;
}

/** Recta dominante por Hough entre los píxeles activos. */
function strongestHoughLine(
  changedPixels: ChangedPixels,
  isActive: Uint8Array,
  width: number,
  height: number,
  angleCount: number,
  cosines: Float64Array,
  sines: Float64Array,
): { angleIndex: number; rho: number; votes: number } | null {
  const maximumRho = Math.ceil(Math.hypot(width, height));
  const rhoBinCount = 2 * maximumRho + 1;
  const votes = new Uint16Array(angleCount * rhoBinCount);
  let bestVotes = 0;
  let bestAngleIndex = 0;
  let bestRhoBin = 0;
  for (let pixelIndex = 0; pixelIndex < changedPixels.count; pixelIndex++) {
    if (!isActive[pixelIndex]) continue;
    const pixelX = changedPixels.xs[pixelIndex]!;
    const pixelY = changedPixels.ys[pixelIndex]!;
    for (let angleIndex = 0; angleIndex < angleCount; angleIndex++) {
      const rhoBin = Math.round(pixelX * cosines[angleIndex]! + pixelY * sines[angleIndex]!) + maximumRho;
      const voteIndex = angleIndex * rhoBinCount + rhoBin;
      const voteCount = votes[voteIndex]! + 1;
      votes[voteIndex] = voteCount;
      if (voteCount > bestVotes) {
        bestVotes = voteCount;
        bestAngleIndex = angleIndex;
        bestRhoBin = rhoBin;
      }
    }
  }
  if (bestVotes === 0) return null;
  return { angleIndex: bestAngleIndex, rho: bestRhoBin - maximumRho, votes: bestVotes };
}

/**
 * Segmentos rectos entre los píxeles que cambian: Hough, tramo continuo más largo y vuelta a
 * empezar sin los píxeles usados.
 */
export function findLineSegments(
  changedPixels: ChangedPixels,
  width: number,
  height: number,
  options: MeteorDetectionOptions,
): LineSegment[] {
  const angleCount = 180;
  const cosines = new Float64Array(angleCount);
  const sines = new Float64Array(angleCount);
  for (let angleIndex = 0; angleIndex < angleCount; angleIndex++) {
    cosines[angleIndex] = Math.cos((angleIndex * Math.PI) / angleCount);
    sines[angleIndex] = Math.sin((angleIndex * Math.PI) / angleCount);
  }
  const isActive = new Uint8Array(changedPixels.count).fill(1);
  const segments: LineSegment[] = [];
  const minimumVotes = Math.max(4, Math.floor(options.minimumSegmentLengthPixels * options.minimumCoverage));
  for (let attempt = 0; attempt < options.maximumSegmentsPerFrame * 3 && segments.length < options.maximumSegmentsPerFrame; attempt++) {
    const houghLine = strongestHoughLine(changedPixels, isActive, width, height, angleCount, cosines, sines);
    if (!houghLine || houghLine.votes < minimumVotes) break;
    const lineCosine = cosines[houghLine.angleIndex]!;
    const lineSine = sines[houghLine.angleIndex]!;
    // Píxeles cerca de la recta, con su posición a lo largo de ella (dirección (−sen, cos)).
    const nearbyPixels: { pixelIndex: number; alongPosition: number; perpendicularOffset: number }[] = [];
    for (let pixelIndex = 0; pixelIndex < changedPixels.count; pixelIndex++) {
      if (!isActive[pixelIndex]) continue;
      const pixelX = changedPixels.xs[pixelIndex]!;
      const pixelY = changedPixels.ys[pixelIndex]!;
      const perpendicularOffset = pixelX * lineCosine + pixelY * lineSine - houghLine.rho;
      if (Math.abs(perpendicularOffset) > options.lineTolerancePixels) continue;
      nearbyPixels.push({ pixelIndex, alongPosition: -pixelX * lineSine + pixelY * lineCosine, perpendicularOffset });
    }
    nearbyPixels.sort((first, second) => first.alongPosition - second.alongPosition);
    // Tramo continuo más largo (sin huecos mayores que `maximumGapPixels`).
    let bestRunStart = 0;
    let bestRunEnd = -1;
    let runStart = 0;
    for (let nearbyIndex = 1; nearbyIndex <= nearbyPixels.length; nearbyIndex++) {
      const isRunBroken =
        nearbyIndex === nearbyPixels.length ||
        nearbyPixels[nearbyIndex]!.alongPosition - nearbyPixels[nearbyIndex - 1]!.alongPosition > options.maximumGapPixels;
      if (!isRunBroken) continue;
      const runLength = nearbyPixels[nearbyIndex - 1]!.alongPosition - nearbyPixels[runStart]!.alongPosition;
      const bestLength = bestRunEnd < 0 ? -1 : nearbyPixels[bestRunEnd]!.alongPosition - nearbyPixels[bestRunStart]!.alongPosition;
      if (runLength > bestLength) {
        bestRunStart = runStart;
        bestRunEnd = nearbyIndex - 1;
      }
      runStart = nearbyIndex;
    }
    if (bestRunEnd < 0) break;
    const runPixels = nearbyPixels.slice(bestRunStart, bestRunEnd + 1);
    // Los píxeles de este tramo no vuelven a votar, sea segmento o no.
    for (const runPixel of runPixels) isActive[runPixel.pixelIndex] = 0;
    const firstAlong = runPixels[0]!.alongPosition;
    const lastAlong = runPixels[runPixels.length - 1]!.alongPosition;
    const lengthPixels = lastAlong - firstAlong;
    const coveredPositions = new Set(runPixels.map((runPixel) => Math.round(runPixel.alongPosition)));
    const coverage = coveredPositions.size / (Math.round(lastAlong) - Math.round(firstAlong) + 1);
    if (lengthPixels < options.minimumSegmentLengthPixels || coverage < options.minimumCoverage) continue;
    // Extremos sobre la recta (punto más cercano al origen + posición a lo largo).
    const footX = houghLine.rho * lineCosine;
    const footY = houghLine.rho * lineSine;
    let peakExcess = 0;
    for (const runPixel of runPixels) peakExcess = Math.max(peakExcess, changedPixels.excesses[runPixel.pixelIndex]!);
    segments.push({
      startX: footX - firstAlong * lineSine,
      startY: footY + firstAlong * lineCosine,
      endX: footX - lastAlong * lineSine,
      endY: footY + lastAlong * lineCosine,
      lengthPixels,
      pixelCount: runPixels.length,
      coverage,
      peakExcess,
    });
  }
  return segments;
}

/** Manchas (componentes 8-conexas) de los píxeles que cambian: su centro. */
function changeBlobs(changedPixels: ChangedPixels, mask: Uint8Array, width: number): ChangeFeature[] {
  const pixelIndexByPosition = new Map<number, number>();
  for (let pixelIndex = 0; pixelIndex < changedPixels.count; pixelIndex++) {
    pixelIndexByPosition.set(changedPixels.ys[pixelIndex]! * width + changedPixels.xs[pixelIndex]!, pixelIndex);
  }
  const isVisited = new Uint8Array(changedPixels.count);
  const blobs: ChangeFeature[] = [];
  for (let seedIndex = 0; seedIndex < changedPixels.count; seedIndex++) {
    if (isVisited[seedIndex]) continue;
    isVisited[seedIndex] = 1;
    const pendingIndices = [seedIndex];
    let sumX = 0;
    let sumY = 0;
    let blobPixelCount = 0;
    while (pendingIndices.length > 0) {
      const pixelIndex = pendingIndices.pop()!;
      const pixelX = changedPixels.xs[pixelIndex]!;
      const pixelY = changedPixels.ys[pixelIndex]!;
      sumX += pixelX;
      sumY += pixelY;
      blobPixelCount++;
      for (let rowOffset = -1; rowOffset <= 1; rowOffset++) {
        for (let columnOffset = -1; columnOffset <= 1; columnOffset++) {
          const neighbourPosition = (pixelY + rowOffset) * width + pixelX + columnOffset;
          if (!mask[neighbourPosition]) continue;
          const neighbourIndex = pixelIndexByPosition.get(neighbourPosition);
          if (neighbourIndex === undefined || isVisited[neighbourIndex]) continue;
          isVisited[neighbourIndex] = 1;
          pendingIndices.push(neighbourIndex);
        }
      }
    }
    blobs.push({ centerX: sumX / blobPixelCount, centerY: sumY / blobPixelCount });
  }
  return blobs;
}

/**
 * Algún rasgo del fotograma está sobre la recta del segmento, cerca de él: hasta
 * `frameDistance` veces (1,5 × su longitud) más allá de cada extremo. Un objeto lento avanza en
 * cada fotograma más o menos lo que mide su trazo (la exposición ocupa casi todo el intervalo).
 */
function hasFeatureAlongSegment(
  segment: LineSegment,
  features: readonly ChangeFeature[],
  toleranceAcross: number,
  frameDistance = 1,
): boolean {
  const directionX = (segment.endX - segment.startX) / Math.max(1e-6, segment.lengthPixels);
  const directionY = (segment.endY - segment.startY) / Math.max(1e-6, segment.lengthPixels);
  const alongMargin = frameDistance * Math.max(1.5 * segment.lengthPixels, 20);
  for (const feature of features) {
    const relativeX = feature.centerX - segment.startX;
    const relativeY = feature.centerY - segment.startY;
    const alongPosition = relativeX * directionX + relativeY * directionY;
    const acrossDistance = Math.abs(-relativeX * directionY + relativeY * directionX);
    if (acrossDistance <= toleranceAcross && alongPosition >= -alongMargin && alongPosition <= segment.lengthPixels + alongMargin) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Vigilante
// ---------------------------------------------------------------------------------------------

export class MeteorWatcher {
  private readonly options: MeteorDetectionOptions;
  private readonly recentFrames: Uint8Array[] = [];
  private readonly backgroundBytes: Uint8Array;
  private readonly frameHistory: FrameHistoryEntry[] = [];
  private pendingCandidates: PendingCandidate[] = [];
  /** Últimos meteoros confirmados, para no contar dos veces uno que cae en dos fotogramas. */
  private readonly recentMeteors: MeteorEvent[] = [];
  private nextFrameIndex = 0;
  private firstWatchedTimestamp: number | null = null;
  private lastWatchedTimestamp = 0;
  private processedFrameCount = 0;
  private skippedFrameCount = 0;
  private meteorCount = 0;
  private rejectedSlowMoverCount = 0;

  constructor(
    readonly width: number,
    readonly height: number,
    detectionOptions: Partial<MeteorDetectionOptions> = {},
  ) {
    this.options = { ...defaultMeteorDetectionOptions, ...detectionOptions };
    this.backgroundBytes = new Uint8Array(width * height);
  }

  /** Analiza un fotograma y devuelve los meteoros que quedan confirmados con él (de fotogramas anteriores). */
  addFrame(frameBytes: Uint8Array, timestampMilliseconds: number): { confirmedMeteors: MeteorEvent[]; analysis: MeteorFrameAnalysis } {
    if (frameBytes.length !== this.width * this.height) throw new Error('El fotograma no tiene el tamaño esperado');
    const frameIndex = this.nextFrameIndex++;
    const analysis = this.analyzeFrame(frameBytes);
    if (!analysis.isWarmingUp) {
      this.processedFrameCount++;
      if (analysis.wasSkippedAsGlobalChange) this.skippedFrameCount++;
      this.firstWatchedTimestamp ??= timestampMilliseconds;
      this.lastWatchedTimestamp = timestampMilliseconds;
      this.frameHistory.push({ frameIndex, features: analysis.features });
      const historyLimit = 2 * this.options.neighbourFrameCount + 2;
      while (this.frameHistory.length > historyLimit) this.frameHistory.shift();
      for (const segment of analysis.segments) {
        this.pendingCandidates.push({ frameIndex, timestampMilliseconds, segment, frameBytes: frameBytes.slice() });
      }
    }
    // El fotograma entra en el fondo después de analizarlo.
    this.recentFrames.push(frameBytes.slice());
    while (this.recentFrames.length > this.options.backgroundFrameCount) this.recentFrames.shift();
    return { confirmedMeteors: this.confirmReadyCandidates(frameIndex, false), analysis };
  }

  /** Al terminar: decide los candidatos pendientes con los fotogramas que haya. */
  flush(): MeteorEvent[] {
    return this.confirmReadyCandidates(this.nextFrameIndex - 1, true);
  }

  statistics(): MeteorWatchStatistics {
    return {
      processedFrameCount: this.processedFrameCount,
      skippedFrameCount: this.skippedFrameCount,
      meteorCount: this.meteorCount,
      rejectedSlowMoverCount: this.rejectedSlowMoverCount,
      watchedMilliseconds: this.firstWatchedTimestamp === null ? 0 : this.lastWatchedTimestamp - this.firstWatchedTimestamp,
    };
  }

  private analyzeFrame(frameBytes: Uint8Array): MeteorFrameAnalysis {
    const { width, height, options } = this;
    if (this.recentFrames.length < options.backgroundFrameCount) {
      return { isWarmingUp: true, wasSkippedAsGlobalChange: false, changedPixelCount: 0, noiseSigma: 0, segments: [], features: [] };
    }
    const backgroundBytes = medianOfFrames(this.recentFrames, this.backgroundBytes);
    const noiseSigma = Math.max(1, robustDifferenceSigma(frameBytes, backgroundBytes));
    const threshold = options.thresholdSigmas * noiseSigma;
    const pixelCount = width * height;
    const maximumChangedCount = Math.floor(options.maximumChangedFraction * pixelCount);

    // Umbral (sin el borde de un píxel, para mirar vecinos sin comprobar límites).
    const mask = new Uint8Array(pixelCount);
    let changedPixelCount = 0;
    for (let rowIndex = 1; rowIndex < height - 1; rowIndex++) {
      for (let columnIndex = 1; columnIndex < width - 1; columnIndex++) {
        const pixelIndex = rowIndex * width + columnIndex;
        if (frameBytes[pixelIndex]! - backgroundBytes[pixelIndex]! > threshold) {
          mask[pixelIndex] = 1;
          changedPixelCount++;
        }
      }
    }
    if (changedPixelCount > maximumChangedCount) {
      return { isWarmingUp: false, wasSkippedAsGlobalChange: true, changedPixelCount, noiseSigma, segments: [], features: [] };
    }

    // Sin los píxeles aislados.
    const xs = new Int32Array(changedPixelCount);
    const ys = new Int32Array(changedPixelCount);
    const excesses = new Float32Array(changedPixelCount);
    let keptCount = 0;
    for (let rowIndex = 1; rowIndex < height - 1; rowIndex++) {
      for (let columnIndex = 1; columnIndex < width - 1; columnIndex++) {
        const pixelIndex = rowIndex * width + columnIndex;
        if (!mask[pixelIndex]) continue;
        const hasChangedNeighbour =
          mask[pixelIndex - width - 1] ||
          mask[pixelIndex - width] ||
          mask[pixelIndex - width + 1] ||
          mask[pixelIndex - 1] ||
          mask[pixelIndex + 1] ||
          mask[pixelIndex + width - 1] ||
          mask[pixelIndex + width] ||
          mask[pixelIndex + width + 1];
        if (!hasChangedNeighbour) continue;
        xs[keptCount] = columnIndex;
        ys[keptCount] = rowIndex;
        excesses[keptCount] = frameBytes[pixelIndex]! - backgroundBytes[pixelIndex]!;
        keptCount++;
      }
    }
    // La máscara sin los aislados, para las manchas.
    const cleanMask = new Uint8Array(pixelCount);
    for (let keptIndex = 0; keptIndex < keptCount; keptIndex++) cleanMask[ys[keptIndex]! * width + xs[keptIndex]!] = 1;
    const changedPixels: ChangedPixels = { xs, ys, excesses, count: keptCount };
    const segments = keptCount > 0 ? findLineSegments(changedPixels, width, height, options) : [];
    const blobs = keptCount > 0 ? changeBlobs(changedPixels, cleanMask, width) : [];
    return {
      isWarmingUp: false,
      wasSkippedAsGlobalChange: false,
      changedPixelCount: keptCount,
      noiseSigma,
      segments,
      features: [
        ...blobs,
        ...segments.flatMap((segment) => [
          { centerX: segment.startX, centerY: segment.startY },
          { centerX: segment.endX, centerY: segment.endY },
        ]),
      ],
    };
  }

  private confirmReadyCandidates(latestFrameIndex: number, isFlushing: boolean): MeteorEvent[] {
    const { options } = this;
    const confirmedMeteors: MeteorEvent[] = [];
    const stillPending: PendingCandidate[] = [];
    for (const candidate of this.pendingCandidates) {
      if (!isFlushing && latestFrameIndex - candidate.frameIndex < options.neighbourFrameCount) {
        stillPending.push(candidate);
        continue;
      }
      let neighbourFramesWithTrace = 0;
      for (const historyEntry of this.frameHistory) {
        const frameDistance = Math.abs(historyEntry.frameIndex - candidate.frameIndex);
        if (frameDistance === 0 || frameDistance > options.neighbourFrameCount) continue;
        if (hasFeatureAlongSegment(candidate.segment, historyEntry.features, 3 * options.lineTolerancePixels, frameDistance)) {
          neighbourFramesWithTrace++;
        }
      }
      if (neighbourFramesWithTrace >= options.slowMoverNeighbourCount) {
        this.rejectedSlowMoverCount++;
        continue;
      }
      // Un meteoro que cae en dos fotogramas da dos candidatos en la misma recta: se cuenta uno.
      const candidateMidpoint = {
        centerX: (candidate.segment.startX + candidate.segment.endX) / 2,
        centerY: (candidate.segment.startY + candidate.segment.endY) / 2,
      };
      const isDuplicate = this.recentMeteors.some(
        (recentMeteor) =>
          Math.abs(recentMeteor.frameIndex - candidate.frameIndex) <= 1 &&
          hasFeatureAlongSegment(recentMeteor.segment, [candidateMidpoint], 3 * options.lineTolerancePixels),
      );
      if (isDuplicate) continue;
      this.meteorCount++;
      const meteorEvent: MeteorEvent = {
        frameIndex: candidate.frameIndex,
        timestampMilliseconds: candidate.timestampMilliseconds,
        segment: candidate.segment,
        frameBytes: candidate.frameBytes,
        width: this.width,
        height: this.height,
      };
      confirmedMeteors.push(meteorEvent);
      this.recentMeteors.push(meteorEvent);
      while (this.recentMeteors.length > 8) this.recentMeteors.shift();
    }
    this.pendingCandidates = stillPending;
    return confirmedMeteors;
  }
}

/** Meteoros por hora (null si se ha vigilado menos de un minuto: la cifra no dice nada). */
export function meteorsPerHour(meteorCount: number, watchedMilliseconds: number): number | null {
  if (watchedMilliseconds < 60_000) return null;
  return meteorCount / (watchedMilliseconds / 3_600_000);
}
