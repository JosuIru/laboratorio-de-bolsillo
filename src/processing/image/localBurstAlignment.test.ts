import { computeLuminance, estimateFrameOffset, mergeFramesToFinerGrid } from './burstSuperResolution';
import type { GrayImage } from './grayImage';
import { findAlignmentPoints, type LocalShift } from './luckyImaging';
import {
  defaultLocalAlignmentOptions,
  denseDisplacement,
  equalizeFrameColorGains,
  evaluateAffineDisplacement,
  fitRobustAffineDisplacement,
  measureFrameLocalAlignment,
  mergeFramesWithDisplacements,
  superResolveBurstWithLocalAlignment,
} from './localBurstAlignment';
import {
  blurredSceneBrightness,
  createSceneWaves,
  type FrameMotion,
  frameToScenePosition,
  interiorRootMeanSquareError,
  renderSyntheticFrame,
  sceneToFramePosition,
} from './superzoomSynthetic.testHelpers';

const frameSize = 256;
const opticalBlurSigmaPixels = 0.66;
const sceneWaves = createSceneWaves(20260926);

/** Ráfaga a mano: traslaciones subpíxel variadas, giros de 0,3–0,5° y cizalla de obturador. */
const burstMotions: FrameMotion[] = [
  { rotationDegrees: 0, translationX: 0, translationY: 0, rollingShutterShear: 0 },
  { rotationDegrees: 0.4, translationX: 3.3, translationY: -1.6, rollingShutterShear: 0.004 },
  { rotationDegrees: -0.35, translationX: -2.4, translationY: 2.7, rollingShutterShear: -0.003 },
  { rotationDegrees: 0.5, translationX: 1.8, translationY: 4.4, rollingShutterShear: 0.002 },
  { rotationDegrees: -0.3, translationX: -4.2, translationY: -3.1, rollingShutterShear: 0.005 },
  { rotationDegrees: 0.45, translationX: 0.6, translationY: -2.2, rollingShutterShear: -0.004 },
];

let renderedBurst: Uint8Array[] | null = null;

function renderBurst(): Uint8Array[] {
  renderedBurst ??= burstMotions.map((motion, frameIndex) =>
    renderSyntheticFrame(sceneWaves, {
      size: frameSize,
      motion,
      opticalBlurSigmaPixels,
      noiseSigma: 1.5,
      noiseSeed: 100 + frameIndex,
    }),
  );
  return renderedBurst;
}

function grayFromRgb(rgbPixels: Uint8Array): GrayImage {
  return { width: frameSize, height: frameSize, values: computeLuminance(rgbPixels, frameSize) };
}

describe('fitRobustAffineDisplacement', () => {
  it('recupera un giro con cizalla y descarta los puntos de algo que se ha movido', () => {
    const center = 100;
    const rotationRadians = (0.4 * Math.PI) / 180;
    const localShifts: LocalShift[] = [];
    for (let positionY = 10; positionY <= 190; positionY += 20) {
      for (let positionX = 10; positionX <= 190; positionX += 20) {
        const relativeX = positionX - center;
        const relativeY = positionY - center;
        const isMovingObject = positionX > 150 && positionY > 150;
        localShifts.push({
          positionX,
          positionY,
          shiftX: 0.5 - rotationRadians * relativeY + 0.003 * relativeY + (isMovingObject ? 3 : 0),
          shiftY: -0.2 + rotationRadians * relativeX,
        });
      }
    }
    const { affine, inlierShifts } = fitRobustAffineDisplacement(localShifts, center, center);
    expect(affine.offsetX).toBeCloseTo(0.5, 3);
    expect(affine.offsetY).toBeCloseTo(-0.2, 3);
    expect(affine.xFromY).toBeCloseTo(-rotationRadians + 0.003, 5);
    expect(affine.yFromX).toBeCloseTo(rotationRadians, 5);
    expect(inlierShifts.length).toBe(localShifts.length - 4);
  });
});

describe('measureFrameLocalAlignment', () => {
  it('mide el desplazamiento por zonas mucho mejor que una sola traslación', () => {
    const [referencePixels, , , rotatedPixels] = renderBurst();
    const reference = grayFromRgb(referencePixels!);
    const frame = grayFromRgb(rotatedPixels!);
    const referenceMotion = burstMotions[0]!;
    const frameMotion = burstMotions[3]!;
    const globalOffset = estimateFrameOffset(reference.values, frame.values, frameSize, 16);
    const options = defaultLocalAlignmentOptions(frameSize);
    const alignmentPoints = findAlignmentPoints(reference, options.pointSpacingPixels, options.patchRadiusPixels, options.coarseSearchRadiusPixels);
    const localAlignment = measureFrameLocalAlignment(reference, frame, globalOffset, alignmentPoints, options);
    expect(localAlignment).not.toBeNull();

    const globalOnly = denseDisplacement(frameSize, globalOffset);
    const withLocal = denseDisplacement(frameSize, globalOffset, localAlignment!.field);
    let globalSquaredError = 0;
    let localSquaredError = 0;
    let largestGlobalError = 0;
    let largestLocalError = 0;
    let sampleCount = 0;
    for (let rowIndex = 4; rowIndex < frameSize - 4; rowIndex += 3) {
      for (let columnIndex = 4; columnIndex < frameSize - 4; columnIndex += 3) {
        const scenePosition = frameToScenePosition(referenceMotion, frameSize, columnIndex, rowIndex);
        const truePosition = sceneToFramePosition(frameMotion, frameSize, scenePosition.x, scenePosition.y);
        const trueShiftX = truePosition.x - columnIndex;
        const trueShiftY = truePosition.y - rowIndex;
        const pixelIndex = rowIndex * frameSize + columnIndex;
        const globalError = Math.hypot(globalOnly.shiftX[pixelIndex]! - trueShiftX, globalOnly.shiftY[pixelIndex]! - trueShiftY);
        const localError = Math.hypot(withLocal.shiftX[pixelIndex]! - trueShiftX, withLocal.shiftY[pixelIndex]! - trueShiftY);
        globalSquaredError += globalError ** 2;
        localSquaredError += localError ** 2;
        largestGlobalError = Math.max(largestGlobalError, globalError);
        largestLocalError = Math.max(largestLocalError, localError);
        sampleCount++;
      }
    }
    const globalRms = Math.sqrt(globalSquaredError / sampleCount);
    const localRms = Math.sqrt(localSquaredError / sampleCount);
    // Giro de 0,5° en 256 px: hasta ~1,1 px en las esquinas con solo el global.
    expect(globalRms).toBeGreaterThan(0.4);
    expect(largestGlobalError).toBeGreaterThan(0.9);
    expect(localRms).toBeLessThan(0.08);
    expect(largestLocalError).toBeLessThan(0.25);
    // El afín ha visto el giro (0,5°, en radianes) con la cizalla aparte.
    const measuredRotationDegrees = (((localAlignment!.affine.yFromX - localAlignment!.affine.xFromY) / 2) * 180) / Math.PI;
    expect(Math.abs(measuredRotationDegrees)).toBeGreaterThan(0.35);
    expect(evaluateAffineDisplacement(localAlignment!.affine, 0, 0).x).not.toBeNaN();
    console.info(
      `Alineado por zonas: error medio ${localRms.toFixed(3)} px (máx. ${largestLocalError.toFixed(2)}) ` +
        `frente a ${globalRms.toFixed(3)} px (máx. ${largestGlobalError.toFixed(2)}) solo global`,
    );
  });
});

describe('mergeFramesWithDisplacements', () => {
  it('sin campo local coincide con la fusión por traslación', () => {
    const frames = renderBurst().slice(0, 3);
    const offsets = [
      { offsetX: 0, offsetY: 0 },
      { offsetX: 0.4, offsetY: -0.7 },
      { offsetX: -1.3, offsetY: 0.25 },
    ];
    const translationMerge = mergeFramesToFinerGrid(frames, offsets, [null, null, null], frameSize, { scale: 2, kernelSigmaPixels: 0.45 });
    const displacementMerge = mergeFramesWithDisplacements(
      frames,
      offsets.map((offset, frameIndex) => (frameIndex === 0 ? null : denseDisplacement(frameSize, offset))),
      [null, null, null],
      frameSize,
      { scale: 2, kernelSigmaPixels: 0.45 },
    );
    // Solo cambia el borde (aquí lo de fuera del fotograma pesa 0 igual) y la tabla de pesos.
    const greenOf = (channels: Float32Array) => channels.filter((_value, valueIndex) => valueIndex % 3 === 1);
    expect(
      interiorRootMeanSquareError(greenOf(translationMerge.channels), greenOf(displacementMerge.channels), frameSize * 2, 12),
    ).toBeLessThan(0.3);
  });
});

describe('superResolveBurstWithLocalAlignment', () => {
  it('con giros y obturador, la fusión se acerca más a la escena que con solo el global', () => {
    const frames = renderBurst();
    const commonOptions = { scale: 2, keptFraction: 1, maximumShiftPixels: 16 };
    const globalResult = superResolveBurstWithLocalAlignment(frames, frameSize, { ...commonOptions, useLocalAlignment: false });
    const localResult = superResolveBurstWithLocalAlignment(frames, frameSize, { ...commonOptions, useLocalAlignment: true });
    expect(localResult.referenceFrameIndex).toBe(globalResult.referenceFrameIndex);

    const referenceMotion = burstMotions[localResult.referenceFrameIndex]!;
    const outputSize = frameSize * 2;
    const trueLuminance = new Float32Array(outputSize * outputSize);
    for (let outputRow = 0; outputRow < outputSize; outputRow++) {
      for (let outputColumn = 0; outputColumn < outputSize; outputColumn++) {
        const scenePosition = frameToScenePosition(referenceMotion, frameSize, (outputColumn + 0.5) / 2 - 0.5, (outputRow + 0.5) / 2 - 0.5);
        trueLuminance[outputRow * outputSize + outputColumn] = blurredSceneBrightness(
          sceneWaves,
          scenePosition.x,
          scenePosition.y,
          opticalBlurSigmaPixels,
        );
      }
    }
    const luminanceOf = (channels: Float32Array) => {
      const luminance = new Float32Array(outputSize * outputSize);
      for (let pixelIndex = 0; pixelIndex < luminance.length; pixelIndex++) {
        // Los tintes 1,02 / 1 / 0,94 dan una luminancia de 1,0005 veces el gris de la escena.
        luminance[pixelIndex] =
          (0.299 * channels[pixelIndex * 3]! + 0.587 * channels[pixelIndex * 3 + 1]! + 0.114 * channels[pixelIndex * 3 + 2]!) / 1.00046;
      }
      return luminance;
    };
    const margin = 24;
    const globalError = interiorRootMeanSquareError(luminanceOf(globalResult.image.channels), trueLuminance, outputSize, margin);
    const localError = interiorRootMeanSquareError(luminanceOf(localResult.image.channels), trueLuminance, outputSize, margin);
    expect(localResult.locallyAlignedFrameCount).toBe(frames.length - 1);
    expect(localResult.alignmentPointCount).toBeGreaterThan(50);
    expect(localResult.meanMaximumLocalCorrectionPixels).toBeGreaterThan(0.7);
    expect(localResult.meanRotationDegrees).toBeGreaterThan(0.25);
    expect(localError).toBeLessThan(0.75 * globalError);
    console.info(
      `Fusión frente a la escena: ${localError.toFixed(2)} niveles con alineado por zonas, ` +
        `${globalError.toFixed(2)} solo global; tiempos ${JSON.stringify(localResult.stageTimings)}`,
    );
  });
});

describe('equalizeFrameColorGains', () => {
  it('da a cada foto el color medio de la referencia', () => {
    const [, otherPixels] = renderBurst();
    const referencePixels = otherPixels;
    const tintedPixels = Uint8Array.from(otherPixels!, (value, valueOffset) => {
      const channelGain = [1.04, 1, 0.95][valueOffset % 3]!;
      return Math.min(255, Math.round(value * channelGain));
    });
    const { frames, largestGainDeviation } = equalizeFrameColorGains([referencePixels!, tintedPixels], frameSize);
    expect(frames[0]).toBe(referencePixels);
    expect(largestGainDeviation).toBeGreaterThan(0.03);
    const channelMean = (pixels: Uint8Array, channelIndex: number) => {
      let valueSum = 0;
      for (let valueOffset = channelIndex; valueOffset < pixels.length; valueOffset += 3) valueSum += pixels[valueOffset]!;
      return valueSum / (pixels.length / 3);
    };
    for (let channelIndex = 0; channelIndex < 3; channelIndex++) {
      // La misma foto con otro balance: vuelve a sus medias (salvo el redondeo a 8 bits).
      expect(Math.abs(channelMean(frames[1]!, channelIndex) - channelMean(otherPixels!, channelIndex))).toBeLessThan(0.6);
    }
  });
});
