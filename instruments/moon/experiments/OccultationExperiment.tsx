/**
 * Experimento «Ocultación»: se toca la estrella junto al limbo en la vista previa, se graban los
 * fotogramas del vídeo (un recorte pequeño alrededor de la estrella, con su marca de tiempo), se
 * mide el brillo de la estrella en cada uno (`measureApertureFlux`) y se ajusta el instante en que
 * desaparece o reaparece (`fitOccultationTiming`).
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Measurement } from '@/core/measurements/types';
import { exposureAveragedVisibleFraction } from '@/processing/image/occultationTiming';
import { SignalChart } from '@/ui/charts/SignalChart';
import { AppButton, BodyText, Card, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { moonInstrumentId } from '../instrumentId';
import {
  analyzeOccultationRecording,
  type ClockOffsetEstimate,
  estimateClockOffsetFromHttpDate,
  formatUtcWithMilliseconds,
  type OccultationAnalysis,
  type StarFrame,
} from '../occultationAnalysis';
import type { MoonMeasurementValues } from '../schema';
import type { StarRecordingPlan } from '../useMoonFrames';

/** Lado del recorte alrededor de la estrella, en píxeles del fotograma. */
export const starCropSide = 32;
/** Duración máxima de la grabación (a ~30 fotogramas por segundo). */
const maximumRecordingSeconds = 180;
const assumedFramesPerSecond = 30;
/** Servidor para comparar la hora (el mismo que ya consulta la app para buscar actualizaciones). */
const timeReferenceUrl = 'https://api.github.com';

interface OccultationExperimentProps {
  /** Desplazamiento de la estrella respecto al centro de la Luna, en px del fotograma; null si no se ha tocado. */
  starOffsetFromMoon: { x: number; y: number } | null;
  hasMoonDetection: boolean;
  isRecording: boolean;
  recordedFrameCount: number;
  isBusy: boolean;
  /** Tiempo de exposición fijado (s), si hay exposición manual. */
  exposureSeconds: number | null;
  recordStarFrames(plan: StarRecordingPlan, maximumFrameCount: number): Promise<StarFrame[]>;
  stopRecording(): void;
  saveExperimentMeasurement(extraValues: Partial<MoonMeasurementValues>): Promise<Measurement<MoonMeasurementValues> | null>;
}

export function OccultationExperiment({
  starOffsetFromMoon,
  hasMoonDetection,
  isRecording,
  recordedFrameCount,
  isBusy,
  exposureSeconds,
  recordStarFrames,
  stopRecording,
  saveExperimentMeasurement,
}: OccultationExperimentProps) {
  const { t } = useTranslation(moonInstrumentId);
  const themePalette = useThemePalette();
  const [analysis, setAnalysis] = useState<OccultationAnalysis | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [clockOffset, setClockOffset] = useState<ClockOffsetEstimate | null>(null);
  const [isCheckingClock, setIsCheckingClock] = useState(false);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  async function handleRecord() {
    if (!starOffsetFromMoon) return;
    setAnalysis(null);
    setStatusMessage(null);
    setSavedMessage(null);
    try {
      const starFrames = await recordStarFrames(
        { offsetFromMoonX: starOffsetFromMoon.x, offsetFromMoonY: starOffsetFromMoon.y, side: starCropSide },
        maximumRecordingSeconds * assumedFramesPerSecond,
      );
      const recordingAnalysis = analyzeOccultationRecording(starFrames, { exposureSeconds: exposureSeconds ?? 0 });
      if (!recordingAnalysis) {
        setStatusMessage(t('experiments.occultation.tooFewFrames'));
        return;
      }
      setAnalysis(recordingAnalysis);
      if (!recordingAnalysis.timing) setStatusMessage(t('experiments.occultation.noEvent'));
    } catch (recordingError) {
      setStatusMessage(t('core:common.error', { message: String(recordingError) }));
    }
  }

  async function handleCheckClock() {
    setIsCheckingClock(true);
    try {
      const requestStart = Date.now();
      const response = await fetch(timeReferenceUrl, { method: 'HEAD', cache: 'no-store' });
      const responseEnd = Date.now();
      const estimate = estimateClockOffsetFromHttpDate(requestStart, responseEnd, response.headers.get('date'));
      setClockOffset(estimate);
      if (!estimate) setStatusMessage(t('experiments.occultation.clockFailed'));
    } catch {
      setStatusMessage(t('experiments.occultation.clockFailed'));
    } finally {
      setIsCheckingClock(false);
    }
  }

  async function handleSave() {
    if (!analysis?.timing || analysis.eventWallClockMilliseconds === null) return;
    const savedMeasurement = await saveExperimentMeasurement({
      experiment: 'occultation',
      occultationEventUtc: new Date(Math.round(analysis.eventWallClockMilliseconds)).toISOString(),
      occultationUncertaintyMilliseconds: Math.round(analysis.timing.eventTimeUncertaintySeconds * 1000 * 10) / 10,
      occultationEventType: analysis.timing.eventType,
      occultationSignificance: Math.round(analysis.timing.dropSignificance * 10) / 10,
      ...(clockOffset ? { clockOffsetMilliseconds: Math.round(clockOffset.offsetMilliseconds) } : {}),
    });
    setSavedMessage(savedMeasurement ? t('core:instrument.savedMeasurement') : null);
  }

  // Curva de luz y modelo ajustado, para la gráfica.
  const chartSeries = useMemo(() => {
    if (!analysis) return null;
    const fluxValues = Float32Array.from(analysis.samples.map((sample) => sample.flux));
    const timing = analysis.timing;
    const modelValues = timing
      ? Float32Array.from(
          analysis.samples.map(
            (sample) =>
              timing.hiddenLevel +
              (timing.visibleLevel - timing.hiddenLevel) *
                exposureAveragedVisibleFraction(sample.timeSeconds - timing.eventTimeSeconds, {
                  eventType: timing.eventType,
                  model: 'step',
                  exposureSeconds: exposureSeconds ?? 0,
                  limbVelocityMetersPerSecond: 500,
                  wavelengthMeters: 550e-9,
                  moonDistanceMeters: 384_400_000,
                }),
          ),
        )
      : null;
    return { fluxValues, modelValues };
  }, [analysis, exposureSeconds]);

  const timing = analysis?.timing ?? null;
  const durationSeconds = analysis && analysis.samples.length > 0 ? analysis.samples[analysis.samples.length - 1]!.timeSeconds : 0;

  return (
    <Card>
      <SectionTitle>{t('experiments.occultation.title')}</SectionTitle>
      <BodyText tone="secondary">{t('experiments.occultation.explanation')}</BodyText>
      <BodyText tone={starOffsetFromMoon ? 'secondary' : 'primary'}>
        {t(starOffsetFromMoon ? 'experiments.occultation.starMarked' : 'experiments.occultation.tapStar')}
      </BodyText>
      {isRecording ? (
        <>
          <BodyText>
            {t('experiments.occultation.recording', {
              frames: recordedFrameCount,
              seconds: Math.round(recordedFrameCount / assumedFramesPerSecond),
            })}
          </BodyText>
          <AppButton label={t('stopCapture')} onPress={stopRecording} variant="secondary" />
        </>
      ) : (
        <AppButton
          label={t('experiments.occultation.record', { seconds: maximumRecordingSeconds })}
          onPress={() => void handleRecord()}
          isDisabled={isBusy || !starOffsetFromMoon || !hasMoonDetection}
        />
      )}
      {statusMessage ? <BodyText tone="danger">{statusMessage}</BodyText> : null}
      {analysis && chartSeries ? (
        <>
          <SignalChart
            series={[
              { values: chartSeries.fluxValues, color: themePalette.accent },
              ...(chartSeries.modelValues ? [{ values: chartSeries.modelValues, color: '#F97316' }] : []),
            ]}
            height={160}
            verticalRange={{ mode: 'from-zero', minimumMaximum: 1 }}
            revision={analysis.samples.length}
            horizontalLabels={['0 s', `${durationSeconds.toFixed(1)} s`]}
            accessibilityLabel={t('experiments.occultation.chartLabel')}
          />
          <BodyText tone="secondary">
            {t('experiments.occultation.recordingSummary', {
              frames: analysis.samples.length,
              framesPerSecond: analysis.framesPerSecond.toFixed(1),
              jitter: Math.round(analysis.deliveryJitterMilliseconds),
            })}
          </BodyText>
        </>
      ) : null}
      {timing && analysis?.eventWallClockMilliseconds !== null && analysis?.eventWallClockMilliseconds !== undefined ? (
        <>
          <BodyText>
            {t(`experiments.occultation.event.${timing.eventType}`, {
              time: formatUtcWithMilliseconds(analysis.eventWallClockMilliseconds),
              uncertainty: Math.max(1, Math.round(timing.eventTimeUncertaintySeconds * 1000)),
            })}
          </BodyText>
          {clockOffset ? (
            <BodyText>
              {t('experiments.occultation.correctedTime', {
                time: formatUtcWithMilliseconds(analysis.eventWallClockMilliseconds + clockOffset.offsetMilliseconds),
                uncertainty: Math.round(clockOffset.uncertaintyMilliseconds),
              })}
            </BodyText>
          ) : null}
          <BodyText tone={timing.dropSignificance < 5 ? 'danger' : 'secondary'}>
            {t(timing.dropSignificance < 5 ? 'experiments.occultation.doubtful' : 'experiments.occultation.significance', {
              significance: timing.dropSignificance.toFixed(1),
            })}
          </BodyText>
          <AppButton label={t('core:common.save')} onPress={() => void handleSave()} isDisabled={isBusy} />
          {savedMessage ? <BodyText tone="secondary">{savedMessage}</BodyText> : null}
        </>
      ) : null}
      <BodyText tone="secondary">{t('experiments.occultation.clockWarning')}</BodyText>
      <AppButton label={t('experiments.occultation.checkClock')} onPress={() => void handleCheckClock()} isBusy={isCheckingClock} variant="secondary" />
      {clockOffset ? (
        <BodyText tone="secondary">
          {t('experiments.occultation.clockOffset', {
            offset: (clockOffset.offsetMilliseconds / 1000).toFixed(2),
            uncertainty: (clockOffset.uncertaintyMilliseconds / 1000).toFixed(2),
          })}
        </BodyText>
      ) : null}
      <BodyText tone="secondary">{t('experiments.occultation.tips')}</BodyText>
    </Card>
  );
}
