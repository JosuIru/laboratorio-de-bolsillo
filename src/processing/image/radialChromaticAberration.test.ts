import type { FloatRgbImage } from './lunarStacking';
import {
  correctRadialChromaticAberration,
  estimateRadialChromaticScales,
  type OpticalCenter,
  opticalCenterInOutput,
} from './radialChromaticAberration';
import { blurredSceneBrightness, createSceneWaves, interiorRootMeanSquareError } from './superzoomSynthetic.testHelpers';

const imageSize = 320;
const sceneWaves = createSceneWaves(777, 24, 0.3);

/**
 * Imagen con aberración lateral: el canal con escala s muestra en p lo que la escena tiene en
 * centro + (p − centro) / s (su imagen es s veces la verde). Rojo y azul, algo más oscuros.
 */
function renderAberratedImage(opticalCenter: OpticalCenter, redScale: number, blueScale: number): FloatRgbImage {
  const channels = new Float32Array(imageSize * imageSize * 3);
  const channelScales = [redScale, 1, blueScale];
  const channelGains = [0.9, 1, 0.8];
  for (let rowIndex = 0; rowIndex < imageSize; rowIndex++) {
    for (let columnIndex = 0; columnIndex < imageSize; columnIndex++) {
      for (let channelIndex = 0; channelIndex < 3; channelIndex++) {
        const channelScale = channelScales[channelIndex]!;
        const sceneX = opticalCenter.centerX + (columnIndex - opticalCenter.centerX) / channelScale;
        const sceneY = opticalCenter.centerY + (rowIndex - opticalCenter.centerY) / channelScale;
        channels[(rowIndex * imageSize + columnIndex) * 3 + channelIndex] =
          channelGains[channelIndex]! * blurredSceneBrightness(sceneWaves, sceneX, sceneY, 0.8);
      }
    }
  }
  return { size: imageSize, channels };
}

function channelPlane(image: FloatRgbImage, channelIndex: number, gain: number): Float32Array {
  return Float32Array.from({ length: image.size * image.size }, (_unused, pixelIndex) => image.channels[pixelIndex * 3 + channelIndex]! / gain);
}

describe('opticalCenterInOutput', () => {
  it('sitúa el centro de la foto en la rejilla fina del recorte central', () => {
    // Foto de 3024×4032 y recorte de 768 centrado: empieza en (1128, 1632).
    const center = opticalCenterInOutput(3024, 4032, 1128, 1632, 2);
    expect(center.centerX).toBeCloseTo(767.5, 5);
    expect(center.centerY).toBeCloseTo(767.5, 5);
    // Recorte desplazado 10 px a la derecha: el centro óptico queda 20 px a la izquierda en la salida.
    expect(opticalCenterInOutput(3024, 4032, 1138, 1632, 2).centerX).toBeCloseTo(747.5, 5);
  });
});

describe('estimateRadialChromaticScales', () => {
  // Centro óptico fuera del centro de la imagen, como un recorte algo desplazado.
  const opticalCenter = { centerX: 0.42 * imageSize, centerY: 0.55 * imageSize };

  it('recupera las escalas de rojo y azul y la corrección alinea los canales con el verde', () => {
    const trueRedScale = 0.992;
    const trueBlueScale = 1.006;
    const aberratedImage = renderAberratedImage(opticalCenter, trueRedScale, trueBlueScale);
    const estimate = estimateRadialChromaticScales(aberratedImage, opticalCenter);
    expect(estimate.red.isReliable).toBe(true);
    expect(estimate.blue.isReliable).toBe(true);
    expect(Math.abs(estimate.red.scale - trueRedScale)).toBeLessThan(0.0006);
    expect(Math.abs(estimate.blue.scale - trueBlueScale)).toBeLessThan(0.0006);

    const correctedImage = correctRadialChromaticAberration(
      aberratedImage,
      { redScale: estimate.red.scale, blueScale: estimate.blue.scale },
      opticalCenter,
    );
    const green = channelPlane(aberratedImage, 1, 1);
    const redErrorBefore = interiorRootMeanSquareError(channelPlane(aberratedImage, 0, 0.9), green, imageSize, 12);
    const redErrorAfter = interiorRootMeanSquareError(channelPlane(correctedImage, 0, 0.9), green, imageSize, 12);
    const blueErrorBefore = interiorRootMeanSquareError(channelPlane(aberratedImage, 2, 0.8), green, imageSize, 12);
    const blueErrorAfter = interiorRootMeanSquareError(channelPlane(correctedImage, 2, 0.8), green, imageSize, 12);
    expect(redErrorAfter).toBeLessThan(0.2 * redErrorBefore);
    expect(blueErrorAfter).toBeLessThan(0.2 * blueErrorBefore);
    console.info(
      `Aberración cromática: rojo ${estimate.red.scale.toFixed(4)} (real ${trueRedScale}), azul ${estimate.blue.scale.toFixed(4)} ` +
        `(real ${trueBlueScale}); diferencia con el verde R ${redErrorBefore.toFixed(2)}→${redErrorAfter.toFixed(2)}, ` +
        `B ${blueErrorBefore.toFixed(2)}→${blueErrorAfter.toFixed(2)} niveles; ${estimate.edgeSampleCount} muestras de borde`,
    );
  });

  it('sin aberración no corrige nada', () => {
    const cleanImage = renderAberratedImage(opticalCenter, 1, 1);
    const estimate = estimateRadialChromaticScales(cleanImage, opticalCenter);
    expect(Math.abs(estimate.red.scale - 1)).toBeLessThan(0.0006);
    expect(Math.abs(estimate.blue.scale - 1)).toBeLessThan(0.0006);
  });

  it('con escala 1 la corrección deja la imagen igual', () => {
    const cleanImage = renderAberratedImage(opticalCenter, 1, 1);
    const corrected = correctRadialChromaticAberration(cleanImage, { redScale: 1, blueScale: 1 }, opticalCenter);
    expect(corrected.channels).toEqual(cleanImage.channels);
  });
});
