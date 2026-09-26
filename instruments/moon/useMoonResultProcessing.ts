/**
 * Estado del procesado del resultado: «Corregir color», «Nitidez (deconvolución)» y la vista
 * «Luna mineral». El cálculo tarda (hasta unos segundos en recortes grandes), así que se hace
 * fuera del render: se marca «procesando», se deja pintar y luego se calcula.
 */
import { useEffect, useMemo, useState } from 'react';

import type { FloatRgbImage } from '@/processing/image/lunarStacking';

import {
  type DeconvolutionStrength,
  processMoonResult,
  type ProcessedMoonResult,
  renderMineralView,
} from './resultProcessing';

/** Pausa para que se pinte el indicador antes de bloquear el hilo JS calculando. */
const paintDelayMilliseconds = 50;

export interface MoonResultProcessingInput {
  baseImage: FloatRgbImage;
  isColorImage: boolean;
}

export function useMoonResultProcessing(resultInput: MoonResultProcessingInput | null) {
  const [correctColor, setCorrectColor] = useState(false);
  const [deconvolutionStrength, setDeconvolutionStrength] = useState<DeconvolutionStrength>('off');
  const [isMineralViewOn, setIsMineralViewOn] = useState(false);
  const [mineralSaturationGain, setMineralSaturationGain] = useState(5);
  const [processedResult, setProcessedResult] = useState<{ input: MoonResultProcessingInput; key: string; result: ProcessedMoonResult } | null>(null);
  const [mineralImage, setMineralImage] = useState<{ source: FloatRgbImage; gain: number; image: FloatRgbImage | null } | null>(null);

  const processingKey = `${correctColor}-${deconvolutionStrength}`;
  const isProcessingRequested = resultInput !== null && (correctColor || deconvolutionStrength !== 'off');
  const currentProcessed =
    processedResult && processedResult.input === resultInput && processedResult.key === processingKey ? processedResult.result : null;

  useEffect(() => {
    if (!resultInput || !isProcessingRequested || currentProcessed) return;
    let isCancelled = false;
    const calculationTimer = setTimeout(() => {
      if (isCancelled) return;
      let result: ProcessedMoonResult;
      try {
        result = processMoonResult(resultInput.baseImage, {
          correctColor,
          deconvolutionStrength,
          isColorImage: resultInput.isColorImage,
        });
      } catch {
        // Un fallo inesperado no debe dejar la pantalla «procesando» para siempre.
        result = {
          image: resultInput.baseImage,
          report: { colorCorrectionFailed: correctColor, deconvolutionFailed: deconvolutionStrength !== 'off', processingMilliseconds: 0 },
        };
      }
      if (!isCancelled) setProcessedResult({ input: resultInput, key: processingKey, result });
    }, paintDelayMilliseconds);
    return () => {
      isCancelled = true;
      clearTimeout(calculationTimer);
    };
  }, [resultInput, isProcessingRequested, currentProcessed, correctColor, deconvolutionStrength, processingKey]);

  /** Imagen para mostrar (sin el realce), la procesada si ya está. */
  const displayedBaseImage = isProcessingRequested ? (currentProcessed?.image ?? resultInput?.baseImage ?? null) : (resultInput?.baseImage ?? null);

  const isMineralAvailable = resultInput?.isColorImage === true;
  const currentMineral =
    mineralImage && displayedBaseImage && mineralImage.source === displayedBaseImage && mineralImage.gain === mineralSaturationGain ? mineralImage : null;
  useEffect(() => {
    if (!isMineralViewOn || !isMineralAvailable || !displayedBaseImage || currentMineral) return;
    let isCancelled = false;
    const calculationTimer = setTimeout(() => {
      if (isCancelled) return;
      let image: FloatRgbImage | null;
      try {
        image = renderMineralView(displayedBaseImage, mineralSaturationGain);
      } catch {
        image = null;
      }
      if (!isCancelled) setMineralImage({ source: displayedBaseImage, gain: mineralSaturationGain, image });
    }, paintDelayMilliseconds);
    return () => {
      isCancelled = true;
      clearTimeout(calculationTimer);
    };
  }, [isMineralViewOn, isMineralAvailable, displayedBaseImage, currentMineral, mineralSaturationGain]);

  const settingsForSaving = useMemo(
    () => ({
      colorCorrected: correctColor && isMineralAvailable,
      deconvolutionIterations: currentProcessed?.report.deconvolutionIterations,
      mineralSaturationGain: isMineralViewOn && isMineralAvailable ? mineralSaturationGain : undefined,
    }),
    [correctColor, currentProcessed, isMineralAvailable, isMineralViewOn, mineralSaturationGain],
  );

  return {
    correctColor,
    setCorrectColor,
    deconvolutionStrength,
    setDeconvolutionStrength,
    isMineralViewOn,
    setIsMineralViewOn,
    mineralSaturationGain,
    setMineralSaturationGain,
    isMineralAvailable,
    /** La imagen del resultado con el procesado pedido (o la original mientras se calcula). */
    displayedBaseImage,
    /** Vista mineral (null si está apagada, calculándose o si no se encontró el disco). */
    mineralViewImage: isMineralViewOn ? (currentMineral?.image ?? null) : null,
    hasMineralFailed: isMineralViewOn && currentMineral !== null && currentMineral.image === null,
    processingReport: currentProcessed?.report ?? null,
    isCalculating:
      (isProcessingRequested && !currentProcessed) || (isMineralViewOn && isMineralAvailable && displayedBaseImage !== null && !currentMineral),
    settingsForSaving,
  };
}
