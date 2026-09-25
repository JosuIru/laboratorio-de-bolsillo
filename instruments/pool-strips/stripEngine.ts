import type { RegionColorStatistics } from '@/processing/color/regionSampling';

import {
  type ColorimeterReading,
  evaluateColorimeterFrame,
  type UserColorScale,
} from '@instruments/colorimeter/colorimeterEngine';
import type { ReferenceCard } from '@instruments/colorimeter/referenceCards';
import type { CameraPoint } from '@instruments/colorimeter/useColorimeterFrames';

import type { PoolStripsMeasurementValues } from './schema';
import {
  type IdealRange,
  ignoredPadSlot,
  maximumPadCount,
  type StripPadSlot,
  type StripParameter,
  type StripParameterId,
  stripParameters,
  type StripPresetId,
  type StripScaleLevel,
} from './stripPresets';

// ── Guía en pantalla ────────────────────────────────────────────────────────────────────────

/** Rectángulo en puntos de la vista previa. */
export interface ViewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface StripGuideLayout {
  /** Contorno donde se coloca la tira (o la fila de colores de la carta). */
  guideRect: ViewRect;
  /** Una casilla por almohadilla, de izquierda (asa) a derecha. */
  cellRects: ViewRect[];
  /** Zona central de cada casilla que se muestrea: deja margen para no leer bordes ni huecos. */
  sampleRects: ViewRect[];
}

const guideWidthFraction = 0.88;
const minimumGuideHeight = 32;
const maximumGuideHeight = 72;
/** Fracción de la casilla (en cada eje) que se muestrea. */
const sampleSizeFraction = 0.5;

/** Guía alargada y centrada, dividida en `cellCount` casillas iguales. */
export function computeStripGuideLayout(viewWidth: number, viewHeight: number, cellCount: number): StripGuideLayout | null {
  if (viewWidth <= 0 || viewHeight <= 0 || cellCount < 1) return null;
  const guideWidth = viewWidth * guideWidthFraction;
  const cellWidth = guideWidth / cellCount;
  const guideHeight = Math.min(
    Math.max(cellWidth * 0.8, minimumGuideHeight),
    Math.max(minimumGuideHeight, Math.min(maximumGuideHeight, viewHeight * 0.3)),
  );
  const guideRect = {
    left: (viewWidth - guideWidth) / 2,
    top: (viewHeight - guideHeight) / 2,
    width: guideWidth,
    height: guideHeight,
  };
  const cellRects = Array.from({ length: cellCount }, (_, cellIndex) => ({
    left: guideRect.left + cellIndex * cellWidth,
    top: guideRect.top,
    width: cellWidth,
    height: guideHeight,
  }));
  const sampleRects = cellRects.map((cellRect) => ({
    left: cellRect.left + (cellRect.width * (1 - sampleSizeFraction)) / 2,
    top: cellRect.top + (cellRect.height * (1 - sampleSizeFraction)) / 2,
    width: cellRect.width * sampleSizeFraction,
    height: cellRect.height * sampleSizeFraction,
  }));
  return { guideRect, cellRects, sampleRects };
}

// ── Configuración de la tira ────────────────────────────────────────────────────────────────

export function movePadSlot(padSlots: readonly StripPadSlot[], slotIndex: number, offset: -1 | 1): StripPadSlot[] {
  const targetIndex = slotIndex + offset;
  if (slotIndex < 0 || slotIndex >= padSlots.length || targetIndex < 0 || targetIndex >= padSlots.length) {
    return [...padSlots];
  }
  const reorderedSlots = [...padSlots];
  [reorderedSlots[slotIndex], reorderedSlots[targetIndex]] = [reorderedSlots[targetIndex]!, reorderedSlots[slotIndex]!];
  return reorderedSlots;
}

/** Siempre queda al menos una almohadilla. */
export function removePadSlot(padSlots: readonly StripPadSlot[], slotIndex: number): StripPadSlot[] {
  if (padSlots.length <= 1) return [...padSlots];
  return padSlots.filter((_, candidateIndex) => candidateIndex !== slotIndex);
}

/** Añade al final; un parámetro no puede repetirse (los huecos sin leer sí). */
export function addPadSlot(padSlots: readonly StripPadSlot[], addedSlot: StripPadSlot): StripPadSlot[] {
  if (padSlots.length >= maximumPadCount) return [...padSlots];
  if (addedSlot !== ignoredPadSlot && padSlots.includes(addedSlot)) return [...padSlots];
  return [...padSlots, addedSlot];
}

// ── Escalas ─────────────────────────────────────────────────────────────────────────────────

/** Escala fotografiada de la carta del bote, que sustituye a la orientativa. */
export interface CalibratedStripScale {
  levels: StripScaleLevel[];
  /** Epoch en milisegundos. */
  calibratedAt: number;
}

export type CalibratedStripScales = Partial<Record<StripParameterId, CalibratedStripScale>>;

export interface ResolvedStripScale {
  levels: readonly StripScaleLevel[];
  isCalibrated: boolean;
}

export function resolveStripScale(parameterId: StripParameterId, calibratedScales: CalibratedStripScales): ResolvedStripScale {
  const calibratedScale = calibratedScales[parameterId];
  return calibratedScale && calibratedScale.levels.length >= 2
    ? { levels: calibratedScale.levels, isCalibrated: true }
    : { levels: stripParameters[parameterId].defaultScale, isCalibrated: false };
}

/** Adapta la escala al formato del colorímetro para reutilizar su comparación. */
export function toColorimeterScale(parameter: StripParameter, levels: readonly StripScaleLevel[]): UserColorScale {
  return {
    id: parameter.id,
    name: parameter.id,
    unit: parameter.unit,
    entries: levels.map((level) => ({ label: String(level.value), value: level.value, hexColor: level.hexColor })),
  };
}

export type ScaleCaptureProblem = 'too-few-levels' | 'invalid-value' | 'repeated-value' | 'missing-color';

/**
 * Construye una escala calibrada con los valores que escribe el usuario (los de la carta) y los
 * colores medidos en cada casilla de la guía. Devuelve el problema si no se puede.
 */
export function buildCalibratedScale(
  levelValues: readonly (number | null)[],
  measuredHexColors: readonly (string | null)[],
  calibratedAt: number,
): CalibratedStripScale | ScaleCaptureProblem {
  if (levelValues.length < 2) return 'too-few-levels';
  if (levelValues.some((levelValue) => levelValue === null || !Number.isFinite(levelValue))) return 'invalid-value';
  if (new Set(levelValues).size !== levelValues.length) return 'repeated-value';
  if (measuredHexColors.length !== levelValues.length || measuredHexColors.some((hexColor) => !hexColor)) {
    return 'missing-color';
  }
  const levels = levelValues
    .map((levelValue, levelIndex) => ({ value: levelValue!, hexColor: measuredHexColors[levelIndex]! }))
    .sort((leftLevel, rightLevel) => leftLevel.value - rightLevel.value);
  return { levels, calibratedAt };
}

// ── Lectura ─────────────────────────────────────────────────────────────────────────────────

export type RangeStatus = 'low' | 'ideal' | 'high';

export function classifyAgainstIdealRange(measuredValue: number, idealRange: IdealRange): RangeStatus {
  if (idealRange.minimum !== null && measuredValue < idealRange.minimum) return 'low';
  if (idealRange.maximum !== null && measuredValue > idealRange.maximum) return 'high';
  return 'ideal';
}

export type MatchConfidence = 'good' | 'fair' | 'poor';

/** ΔE00 hasta el que el color de la almohadilla encaja bien en la escala. */
export const goodMatchDeltaE = 5;
/** Por encima, la almohadilla no se parece a la escala y el valor no es fiable. */
export const poorMatchDeltaE = 10;

export function classifyMatchConfidence(interpolationDeltaE: number): MatchConfidence {
  if (interpolationDeltaE <= goodMatchDeltaE) return 'good';
  if (interpolationDeltaE <= poorMatchDeltaE) return 'fair';
  return 'poor';
}

export interface StripPadReading {
  /** Posición en la tira (0 = junto al asa). */
  slotIndex: number;
  parameterId: StripParameterId;
  colorReading: ColorimeterReading;
  estimatedValue: number;
  interpolationDeltaE: number;
  confidence: MatchConfidence;
  rangeStatus: RangeStatus;
  isScaleCalibrated: boolean;
}

export interface StripReading {
  /** Solo las almohadillas con parámetro y con color medido, en orden desde el asa. */
  padReadings: StripPadReading[];
  correction: ColorimeterReading['correction'];
  usedPatchCount: number;
}

/**
 * Lee cada almohadilla: corrige su color con los parches de la tarjeta (igual que el
 * colorímetro), lo compara con la escala de su parámetro por ΔE00 interpolando entre niveles y
 * lo clasifica frente al rango recomendado. `padStatistics` va en el orden de `padSlots`.
 */
export function evaluateStripPads(
  padSlots: readonly StripPadSlot[],
  padStatistics: readonly (RegionColorStatistics | null)[],
  referenceStatistics: readonly (RegionColorStatistics | null)[],
  card: ReferenceCard,
  calibratedScales: CalibratedStripScales,
): StripReading | null {
  const padReadings = padSlots.flatMap((padSlot, slotIndex): StripPadReading[] => {
    const measuredPad = padStatistics[slotIndex];
    if (padSlot === ignoredPadSlot || !measuredPad) return [];
    const parameter = stripParameters[padSlot];
    const resolvedScale = resolveStripScale(padSlot, calibratedScales);
    const colorReading = evaluateColorimeterFrame(
      measuredPad,
      referenceStatistics,
      card,
      toColorimeterScale(parameter, resolvedScale.levels),
    );
    const scaleMatch = colorReading.scaleMatch;
    if (!scaleMatch) return [];
    return [
      {
        slotIndex,
        parameterId: padSlot,
        colorReading,
        estimatedValue: scaleMatch.interpolatedValue,
        interpolationDeltaE: scaleMatch.interpolationDeltaE,
        confidence: classifyMatchConfidence(scaleMatch.interpolationDeltaE),
        rangeStatus: classifyAgainstIdealRange(scaleMatch.interpolatedValue, parameter.idealRange),
        isScaleCalibrated: resolvedScale.isCalibrated,
      },
    ];
  });
  if (padReadings.length === 0) return null;
  const firstColorReading = padReadings[0]!.colorReading;
  return { padReadings, correction: firstColorReading.correction, usedPatchCount: firstColorReading.usedPatchCount };
}

/** Color corregido de cada casilla de la carta del bote (para calibrar una escala). */
export function correctChartCellColors(
  cellStatistics: readonly (RegionColorStatistics | null)[],
  referenceStatistics: readonly (RegionColorStatistics | null)[],
  card: ReferenceCard,
): (string | null)[] {
  return cellStatistics.map((measuredCell) =>
    measuredCell ? evaluateColorimeterFrame(measuredCell, referenceStatistics, card, null).correctedSampleHex : null,
  );
}

function roundTo(numericValue: number, fractionDigits: number): number {
  return Math.round(numericValue * 10 ** fractionDigits) / 10 ** fractionDigits;
}

export function buildStripMeasurementValues(
  presetId: StripPresetId,
  stripReading: StripReading,
  secondsAfterDip: number | null,
): PoolStripsMeasurementValues {
  const { padReadings, correction } = stripReading;
  const valuesByQuantity = Object.fromEntries(
    padReadings.map((padReading) => {
      const parameter = stripParameters[padReading.parameterId];
      // Un decimal más de los que se muestran: la interpolación da algo de información extra.
      return [parameter.quantity, roundTo(padReading.estimatedValue, parameter.displayFractionDigits + 1)];
    }),
  );
  const padDeltaE = padReadings.map((padReading) => roundTo(padReading.interpolationDeltaE, 2));
  return {
    stripType: presetId,
    ...valuesByQuantity,
    outOfRangeParameters: padReadings
      .filter((padReading) => padReading.rangeStatus !== 'ideal')
      .map((padReading) => `${stripParameters[padReading.parameterId].quantity}:${padReading.rangeStatus}`)
      .join(','),
    maximumDeltaE: Math.max(...padDeltaE),
    padOrder: padReadings.map((padReading) => padReading.parameterId).join(','),
    padColors: padReadings.map((padReading) => padReading.colorReading.correctedSampleHex).join(','),
    padDeltaE,
    padScaleSources: padReadings.map((padReading) => (padReading.isScaleCalibrated ? 'calibrated' : 'default')).join(','),
    ...(secondsAfterDip !== null ? { secondsAfterDip: Math.round(secondsAfterDip) } : {}),
    correctionModel: correction?.model ?? 'none',
    referencePatchCount: stripReading.usedPatchCount,
    ...(correction ? { correctionMeanResidualDeltaE: roundTo(correction.meanResidualDeltaE, 2) } : {}),
  };
}

/** Texto del rango recomendado, p. ej. «7.2–7.6» o «≤ 0.1». */
export function formatIdealRange(idealRange: IdealRange, formatNumber: (numericValue: number) => string): string {
  if (idealRange.minimum !== null && idealRange.maximum !== null) {
    return `${formatNumber(idealRange.minimum)}–${formatNumber(idealRange.maximum)}`;
  }
  if (idealRange.maximum !== null) return `≤ ${formatNumber(idealRange.maximum)}`;
  if (idealRange.minimum !== null) return `≥ ${formatNumber(idealRange.minimum)}`;
  return '—';
}

// ── De la vista previa a la cámara ──────────────────────────────────────────────────────────

/** Rectángulo en coordenadas de cámara, dado por dos esquinas opuestas. */
export interface CameraRegion {
  firstCorner: CameraPoint;
  secondCorner: CameraPoint;
}

/**
 * Transformación afín de puntos de la vista previa a puntos de cámara. Con la vista en modo
 * `cover` la relación es un giro, una escala y un desplazamiento, así que basta con convertir
 * tres esquinas una vez (con la cámara ya en marcha) y después se calcula sin tocar la vista.
 */
export interface ViewToCameraMapping {
  origin: CameraPoint;
  /** Desplazamiento en cámara por cada punto de la vista hacia la derecha y hacia abajo. */
  horizontalStep: CameraPoint;
  verticalStep: CameraPoint;
}

export function createViewToCameraMapping(
  viewWidth: number,
  viewHeight: number,
  topLeftCameraPoint: CameraPoint,
  topRightCameraPoint: CameraPoint,
  bottomLeftCameraPoint: CameraPoint,
): ViewToCameraMapping | null {
  if (viewWidth <= 0 || viewHeight <= 0) return null;
  return {
    origin: topLeftCameraPoint,
    horizontalStep: {
      x: (topRightCameraPoint.x - topLeftCameraPoint.x) / viewWidth,
      y: (topRightCameraPoint.y - topLeftCameraPoint.y) / viewWidth,
    },
    verticalStep: {
      x: (bottomLeftCameraPoint.x - topLeftCameraPoint.x) / viewHeight,
      y: (bottomLeftCameraPoint.y - topLeftCameraPoint.y) / viewHeight,
    },
  };
}

export function mapViewPointToCamera(mapping: ViewToCameraMapping, viewPoint: CameraPoint): CameraPoint {
  return {
    x: mapping.origin.x + viewPoint.x * mapping.horizontalStep.x + viewPoint.y * mapping.verticalStep.x,
    y: mapping.origin.y + viewPoint.x * mapping.horizontalStep.y + viewPoint.y * mapping.verticalStep.y,
  };
}

export function mapViewRectToCameraRegion(mapping: ViewToCameraMapping, viewRect: ViewRect): CameraRegion {
  return {
    firstCorner: mapViewPointToCamera(mapping, { x: viewRect.left, y: viewRect.top }),
    secondCorner: mapViewPointToCamera(mapping, { x: viewRect.left + viewRect.width, y: viewRect.top + viewRect.height }),
  };
}
