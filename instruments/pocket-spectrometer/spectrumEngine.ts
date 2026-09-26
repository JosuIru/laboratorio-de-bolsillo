import type { PixelLayout } from '@/processing/color/regionSampling';

/**
 * Espectrómetro de bolsillo: una red de difracción (un trozo de CD o DVD, o una lámina de
 * 1000 líneas/mm) delante de la cámara abre la luz en un arcoíris. Se lee la intensidad a lo largo
 * de una línea que cruza ese arcoíris y, con dos líneas de longitud de onda conocida (las del
 * mercurio de un fluorescente), se pasa de posición a nanómetros.
 */

export const profileSampleCount = 240;

export interface FramePoint {
  x: number;
  y: number;
}

/**
 * Perfil de intensidad a lo largo del segmento `start`→`end` (en píxeles del fotograma): en cada
 * uno de los `sampleCount` puntos se promedia una tira perpendicular de `halfThicknessPixels`
 * a cada lado, para quitar ruido. Devuelve la intensidad (R+G+B en 0–765) y el color medio.
 *
 * Con `srgbToLinearTable`, la intensidad se suma en luz lineal (reescalada a 0–765): los bytes
 * de la cámara llevan gamma y, sumados tal cual, aplastan los picos altos y realzan los bajos.
 * El color medio se deja con gamma, que es como se pinta. `saturatedSampleCount` cuenta los
 * puntos con algún píxel a 255: ahí la altura del pico está recortada.
 */
export function sampleProfileAlongLine(
  pixels: Uint8Array,
  frameWidth: number,
  frameHeight: number,
  bytesPerRow: number,
  pixelLayout: PixelLayout,
  start: FramePoint,
  end: FramePoint,
  sampleCount: number,
  halfThicknessPixels: number,
  srgbToLinearTable?: Float64Array,
): {
  intensities: Float64Array;
  reds: Float64Array;
  greens: Float64Array;
  blues: Float64Array;
  saturatedSampleCount: number;
} {
  'worklet';
  const bytesPerPixel = pixelLayout === 'rgb' ? 3 : 4;
  const redOffset = pixelLayout === 'bgra' ? 2 : 0;
  const blueOffset = pixelLayout === 'bgra' ? 0 : 2;
  const intensities = new Float64Array(sampleCount);
  const reds = new Float64Array(sampleCount);
  const greens = new Float64Array(sampleCount);
  const blues = new Float64Array(sampleCount);
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const segmentLength = Math.hypot(segmentX, segmentY) || 1;
  // Dirección perpendicular unitaria, para la tira que se promedia en cada punto.
  const perpendicularX = -segmentY / segmentLength;
  const perpendicularY = segmentX / segmentLength;
  const thicknessSteps = Math.max(0, Math.round(halfThicknessPixels));
  let saturatedSampleCount = 0;

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    const fraction = sampleCount === 1 ? 0 : sampleIndex / (sampleCount - 1);
    const centerX = start.x + segmentX * fraction;
    const centerY = start.y + segmentY * fraction;
    let redSum = 0;
    let greenSum = 0;
    let blueSum = 0;
    let linearSum = 0;
    let isSampleSaturated = false;
    let pixelCount = 0;
    for (let offset = -thicknessSteps; offset <= thicknessSteps; offset++) {
      const pixelX = Math.round(centerX + perpendicularX * offset);
      const pixelY = Math.round(centerY + perpendicularY * offset);
      if (pixelX < 0 || pixelY < 0 || pixelX >= frameWidth || pixelY >= frameHeight) continue;
      const pixelStart = pixelY * bytesPerRow + pixelX * bytesPerPixel;
      const redValue = pixels[pixelStart + redOffset]!;
      const greenValue = pixels[pixelStart + 1]!;
      const blueValue = pixels[pixelStart + blueOffset]!;
      redSum += redValue;
      greenSum += greenValue;
      blueSum += blueValue;
      if (srgbToLinearTable) {
        linearSum += srgbToLinearTable[redValue]! + srgbToLinearTable[greenValue]! + srgbToLinearTable[blueValue]!;
      }
      if (redValue === 255 || greenValue === 255 || blueValue === 255) isSampleSaturated = true;
      pixelCount++;
    }
    if (pixelCount === 0) continue;
    if (isSampleSaturated) saturatedSampleCount++;
    reds[sampleIndex] = redSum / pixelCount;
    greens[sampleIndex] = greenSum / pixelCount;
    blues[sampleIndex] = blueSum / pixelCount;
    intensities[sampleIndex] = srgbToLinearTable
      ? (255 * linearSum) / pixelCount
      : (redSum + greenSum + blueSum) / pixelCount;
  }
  return { intensities, reds, greens, blues, saturatedSampleCount };
}

/** Media exponencial de perfiles sucesivos: estabiliza el espectro sin congelarlo. */
export function blendProfiles(
  previousProfile: Float64Array | null,
  newProfile: Float64Array,
  newWeight: number,
): Float64Array {
  if (!previousProfile || previousProfile.length !== newProfile.length) return Float64Array.from(newProfile);
  return previousProfile.map(
    (previousValue, sampleIndex) => previousValue + newWeight * (newProfile[sampleIndex]! - previousValue),
  );
}

// ── Picos ───────────────────────────────────────────────────────────────────────────────────

export interface SpectrumPeak {
  /** Posición fraccionaria (interpolada) en el perfil. */
  position: number;
  intensity: number;
}

/**
 * Máximos locales que superan `minimumRelativeHeight` del máximo y destacan del entorno, con una
 * separación mínima (se queda el más alto). Ordenados de izquierda a derecha.
 */
export function findSpectrumPeaks(
  profile: ArrayLike<number>,
  { minimumRelativeHeight = 0.2, minimumSeparation = 6, maximumPeakCount = 8 } = {},
): SpectrumPeak[] {
  let maximumIntensity = 0;
  let minimumIntensity = Number.POSITIVE_INFINITY;
  for (let sampleIndex = 0; sampleIndex < profile.length; sampleIndex++) {
    maximumIntensity = Math.max(maximumIntensity, profile[sampleIndex]!);
    minimumIntensity = Math.min(minimumIntensity, profile[sampleIndex]!);
  }
  const intensitySpan = maximumIntensity - minimumIntensity;
  if (!(intensitySpan > 0)) return [];
  const heightThreshold = minimumIntensity + minimumRelativeHeight * intensitySpan;

  const candidatePeaks: SpectrumPeak[] = [];
  for (let sampleIndex = 1; sampleIndex < profile.length - 1; sampleIndex++) {
    const sampleValue = profile[sampleIndex]!;
    if (sampleValue < heightThreshold) continue;
    if (!(sampleValue >= profile[sampleIndex - 1]! && sampleValue > profile[sampleIndex + 1]!)) continue;
    const leftValue = profile[sampleIndex - 1]!;
    const rightValue = profile[sampleIndex + 1]!;
    const curvature = leftValue - 2 * sampleValue + rightValue;
    const offset = curvature < 0 ? (0.5 * (leftValue - rightValue)) / curvature : 0;
    candidatePeaks.push({ position: sampleIndex + offset, intensity: sampleValue });
  }
  // De mayor a menor, descartando los que caen demasiado cerca de uno ya elegido.
  const chosenPeaks: SpectrumPeak[] = [];
  for (const candidatePeak of [...candidatePeaks].sort(
    (leftPeak, rightPeak) => rightPeak.intensity - leftPeak.intensity,
  )) {
    if (
      chosenPeaks.every((chosenPeak) => Math.abs(chosenPeak.position - candidatePeak.position) >= minimumSeparation)
    ) {
      chosenPeaks.push(candidatePeak);
    }
    if (chosenPeaks.length >= maximumPeakCount) break;
  }
  return chosenPeaks.sort((leftPeak, rightPeak) => leftPeak.position - rightPeak.position);
}

// ── Calibración ─────────────────────────────────────────────────────────────────────────────

/** Líneas de referencia de un fluorescente (mercurio y el rojo del fósforo de europio), en nm. */
export const fluorescentReferenceLines = [
  { id: 'mercury-blue', wavelengthNm: 435.8 },
  { id: 'mercury-green', wavelengthNm: 546.1 },
  { id: 'europium-red', wavelengthNm: 611.6 },
] as const;

export interface WavelengthCalibration {
  /** Dos puntos (posición en el perfil, longitud de onda). La red dispersa casi linealmente. */
  points: [{ position: number; wavelengthNm: number }, { position: number; wavelengthNm: number }];
  calibratedAt: number;
}

export function isCalibrationUsable(calibration: WavelengthCalibration | null): calibration is WavelengthCalibration {
  if (!calibration) return false;
  const [firstPoint, secondPoint] = calibration.points;
  return (
    Math.abs(secondPoint.position - firstPoint.position) >= 5 && firstPoint.wavelengthNm !== secondPoint.wavelengthNm
  );
}

export function positionToWavelengthNm(calibration: WavelengthCalibration, position: number): number {
  const [firstPoint, secondPoint] = calibration.points;
  const nanometersPerSample =
    (secondPoint.wavelengthNm - firstPoint.wavelengthNm) / (secondPoint.position - firstPoint.position);
  return firstPoint.wavelengthNm + (position - firstPoint.position) * nanometersPerSample;
}

/** Color aproximado (sRGB hex) de una longitud de onda visible, para pintar los picos. */
export function wavelengthToDisplayColor(wavelengthNm: number): string {
  let red = 0;
  let green = 0;
  let blue = 0;
  // Fuera de lo visible (ultravioleta o infrarrojo) no hay color.
  if (wavelengthNm < 380 || wavelengthNm > 780) return '#000000';
  if (wavelengthNm < 440) {
    red = (440 - wavelengthNm) / 60;
    blue = 1;
  } else if (wavelengthNm < 490) {
    green = (wavelengthNm - 440) / 50;
    blue = 1;
  } else if (wavelengthNm < 510) {
    green = 1;
    blue = (510 - wavelengthNm) / 20;
  } else if (wavelengthNm < 580) {
    red = (wavelengthNm - 510) / 70;
    green = 1;
  } else if (wavelengthNm < 645) {
    red = 1;
    green = (645 - wavelengthNm) / 65;
  } else if (wavelengthNm <= 780) {
    red = 1;
  }
  const toHex = (component: number) =>
    Math.round(255 * Math.min(1, Math.max(0, component)))
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

/** Descarta lo corrupto en lugar de fallar: los datos vienen del almacenamiento local. */
export function parseStoredCalibration(storedText: string | null): WavelengthCalibration | null {
  if (!storedText) return null;
  try {
    const parsedValue = JSON.parse(storedText) as Partial<WavelengthCalibration>;
    const points = parsedValue.points;
    if (!Array.isArray(points) || points.length !== 2) return null;
    const areNumbers = points.every(
      (calibrationPoint) =>
        typeof calibrationPoint?.position === 'number' &&
        Number.isFinite(calibrationPoint.position) &&
        typeof calibrationPoint?.wavelengthNm === 'number' &&
        Number.isFinite(calibrationPoint.wavelengthNm),
    );
    const calibration = {
      points: points as WavelengthCalibration['points'],
      calibratedAt: typeof parsedValue.calibratedAt === 'number' ? parsedValue.calibratedAt : 0,
    };
    return areNumbers && isCalibrationUsable(calibration) ? calibration : null;
  } catch {
    return null;
  }
}
