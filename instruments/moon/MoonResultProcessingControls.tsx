/** Interruptores del procesado del resultado: color, deconvolución y Luna mineral. */
import { useTranslation } from 'react-i18next';

import { BodyText } from '@/ui/components';

import { moonInstrumentId } from './instrumentId';
import { ChipSelector, ToggleChip } from './MoonScreenParts';
import { type DeconvolutionStrength, deconvolutionStrengths, mineralSaturationGains } from './resultProcessing';
import type { useMoonResultProcessing } from './useMoonResultProcessing';

export function MoonResultProcessingControls({ resultProcessing }: { resultProcessing: ReturnType<typeof useMoonResultProcessing> }) {
  const { t } = useTranslation(moonInstrumentId);
  const report = resultProcessing.processingReport;
  return (
    <>
      {resultProcessing.isMineralAvailable ? (
        <ToggleChip
          label={t('processing.correctColor')}
          isOn={resultProcessing.correctColor}
          onToggle={() => resultProcessing.setCorrectColor(!resultProcessing.correctColor)}
        />
      ) : null}
      <BodyText tone="secondary">{t('processing.deconvolutionTitle')}</BodyText>
      <ChipSelector<DeconvolutionStrength>
        options={deconvolutionStrengths.map((strength) => ({ value: strength, label: t(`processing.deconvolution.${strength}`) }))}
        selectedValue={resultProcessing.deconvolutionStrength}
        onSelect={resultProcessing.setDeconvolutionStrength}
      />
      {resultProcessing.isMineralAvailable ? (
        <>
          <ToggleChip
            label={t('processing.mineralView')}
            isOn={resultProcessing.isMineralViewOn}
            onToggle={() => resultProcessing.setIsMineralViewOn(!resultProcessing.isMineralViewOn)}
          />
          {resultProcessing.isMineralViewOn ? (
            <>
              <BodyText tone="secondary">{t('processing.mineralExplanation')}</BodyText>
              <ChipSelector
                options={mineralSaturationGains.map((gain) => ({ value: String(gain), label: t('processing.mineralGain', { gain }) }))}
                selectedValue={String(resultProcessing.mineralSaturationGain)}
                onSelect={(gainValue) => resultProcessing.setMineralSaturationGain(Number(gainValue))}
              />
            </>
          ) : null}
          {resultProcessing.hasMineralFailed ? <BodyText tone="danger">{t('processing.mineralFailed')}</BodyText> : null}
        </>
      ) : null}
      {resultProcessing.isCalculating ? <BodyText tone="secondary">{t('processingProgress')}</BodyText> : null}
      {report?.chromaticFringePixels !== undefined ? (
        <BodyText tone="secondary">
          {t('processing.chromaticReport', {
            fringe: report.chromaticFringePixels.toFixed(1),
            redScale: (report.redScale ?? 1).toFixed(3),
            blueScale: (report.blueScale ?? 1).toFixed(3),
          })}
        </BodyText>
      ) : null}
      {report?.whiteBalanceGains ? (
        <BodyText tone="secondary">
          {t('processing.whiteBalanceReport', {
            red: report.whiteBalanceGains.red.toFixed(2),
            blue: report.whiteBalanceGains.blue.toFixed(2),
          })}
        </BodyText>
      ) : null}
      {report?.psfSigmaPixels !== undefined ? (
        <BodyText tone="secondary">
          {t('processing.deconvolutionReport', {
            sigma: report.psfSigmaPixels.toFixed(1),
            iterations: report.deconvolutionIterations ?? 0,
            seconds: (report.processingMilliseconds / 1000).toFixed(1),
          })}
        </BodyText>
      ) : null}
      {report?.colorCorrectionFailed ? <BodyText tone="danger">{t('processing.colorFailed')}</BodyText> : null}
      {report?.deconvolutionFailed ? <BodyText tone="danger">{t('processing.deconvolutionFailed')}</BodyText> : null}
    </>
  );
}
