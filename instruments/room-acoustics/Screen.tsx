import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import { AppButton, BodyText, Card, ScreenContainer, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import {
  type BandReverberation,
  type DecayFit,
  describeRoomCharacter,
  midFrequencyReverberationTime,
  minimumFitCorrelation,
  octaveBandCentersHz,
  preferredReverberationTime,
} from './reverberationAnalysis';
import type { RoomAcousticsMeasurementValues } from './schema';
import { useRoomMeasurement } from './useRoomMeasurement';

export const roomAcousticsInstrumentId = 'room-acoustics';

/** Ruido de fondo (dBFS) por encima del cual conviene buscar un momento más tranquilo. */
const noisyBackgroundDecibels = -45;

function formatSeconds(decayFit: DecayFit | null): string {
  return decayFit && decayFit.correlation >= minimumFitCorrelation ? decayFit.reverberationTimeSeconds.toFixed(2) : '—';
}

export function RoomAcousticsScreen({ saveMeasurement }: InstrumentScreenProps<RoomAcousticsMeasurementValues>) {
  const { t } = useTranslation(roomAcousticsInstrumentId);
  const themePalette = useThemePalette();
  const { measurementState, start, cancel } = useRoomMeasurement();
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const isMeasuring = [
    'starting',
    'warming-up',
    'measuring-noise',
    'waiting-for-impulse',
    'recording-decay',
    'analyzing',
  ].includes(measurementState.phase);
  const measurementResult = measurementState.phase === 'done' ? measurementState.result : null;
  const midReverberationSeconds = measurementResult
    ? midFrequencyReverberationTime(measurementResult.bandResults)
    : null;

  async function handleSave() {
    if (!measurementResult) return;
    setIsSaving(true);
    setStatusMessage(null);
    const octaveResults = measurementResult.bandResults.filter((bandResult) => bandResult.centerHz !== null);
    const roundTo = (numericValue: number, fractionDigits: number) =>
      Math.round(numericValue * 10 ** fractionDigits) / 10 ** fractionDigits;
    try {
      await saveMeasurement({
        values: {
          ...(midReverberationSeconds !== null
            ? {
                midReverberationSeconds: roundTo(midReverberationSeconds, 2),
                roomCharacter: describeRoomCharacter(midReverberationSeconds),
              }
            : {}),
          bandCentersHz: octaveResults.map((bandResult) => bandResult.centerHz!),
          // −1 = sin valor fiable en esa banda (las listas numéricas no admiten huecos).
          bandReverberationSeconds: octaveResults.map((bandResult) => {
            const preferredTime = preferredReverberationTime(bandResult);
            return preferredTime ? roundTo(preferredTime.decayFit.reverberationTimeSeconds, 2) : -1;
          }),
          bandEarlyDecaySeconds: octaveResults.map((bandResult) =>
            bandResult.edt && bandResult.edt.correlation >= minimumFitCorrelation
              ? roundTo(bandResult.edt.reverberationTimeSeconds, 2)
              : -1,
          ),
          bandDynamicRangeDecibels: octaveResults.map((bandResult) => roundTo(bandResult.dynamicRangeDecibels, 1)),
          noiseLevelDecibels: roundTo(measurementResult.noiseLevelDecibels, 1),
          isClipped: measurementResult.isClipped,
        },
      });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <ScreenContainer>
      <Card>
        <SectionTitle>{t('howTo.title')}</SectionTitle>
        <BodyText tone="secondary">{t('howTo.quiet')}</BodyText>
        <BodyText tone="secondary">{t('howTo.impulse')}</BodyText>
        <BodyText tone="secondary">{t('howTo.repeat')}</BodyText>
      </Card>

      <AppButton
        label={isMeasuring ? t('cancel') : measurementResult ? t('measureAgain') : t('start')}
        variant={isMeasuring ? 'secondary' : 'primary'}
        onPress={() => {
          setStatusMessage(null);
          if (isMeasuring) cancel();
          else void start();
        }}
      />

      {isMeasuring ? (
        <Card>
          <BodyText style={styles.phaseText}>{t(`phase.${measurementState.phase}`)}</BodyText>
        </Card>
      ) : null}
      {measurementState.phase === 'error' ? (
        <Card>
          <BodyText tone="danger">
            {measurementState.reason === 'no-impulse'
              ? t('error.noImpulse')
              : t('error.microphone', { message: measurementState.message ?? '' })}
          </BodyText>
        </Card>
      ) : null}

      {measurementResult ? (
        <>
          <Card>
            <BodyText tone="secondary" style={styles.centeredText}>
              {t('midReverberationLabel')}
            </BodyText>
            <BodyText style={styles.mainValue}>
              {midReverberationSeconds !== null ? `${midReverberationSeconds.toFixed(2)} s` : '—'}
            </BodyText>
            <BodyText style={styles.centeredText}>
              {midReverberationSeconds !== null
                ? t(`character.${describeRoomCharacter(midReverberationSeconds)}`)
                : t('noMidValue')}
            </BodyText>
            {measurementResult.isClipped ? <BodyText tone="danger">{t('warning.clipped')}</BodyText> : null}
            {measurementResult.noiseLevelDecibels > noisyBackgroundDecibels ? (
              <BodyText tone="danger">{t('warning.noisy')}</BodyText>
            ) : null}
          </Card>

          <Card>
            <SectionTitle>{t('bands.title')}</SectionTitle>
            <View style={[styles.tableRow, { borderBottomColor: themePalette.border }]}>
              {['band', 'edt', 't20', 't30', 'range'].map((columnKey) => (
                <BodyText key={columnKey} tone="secondary" style={styles.tableCell}>
                  {t(`bands.${columnKey}`)}
                </BodyText>
              ))}
            </View>
            {octaveBandCentersHz.map((centerHz) => {
              const bandResult = measurementResult.bandResults.find(
                (candidateBand): candidateBand is BandReverberation => candidateBand.centerHz === centerHz,
              );
              if (!bandResult) return null;
              return (
                <View key={centerHz} style={[styles.tableRow, { borderBottomColor: themePalette.border }]}>
                  <BodyText style={styles.tableCell}>
                    {centerHz >= 1000 ? `${centerHz / 1000}k` : String(centerHz)}
                  </BodyText>
                  <BodyText style={styles.tableCell}>{formatSeconds(bandResult.edt)}</BodyText>
                  <BodyText style={styles.tableCell}>{formatSeconds(bandResult.t20)}</BodyText>
                  <BodyText style={styles.tableCell}>{formatSeconds(bandResult.t30)}</BodyText>
                  <BodyText style={styles.tableCell}>{Math.round(bandResult.dynamicRangeDecibels)}</BodyText>
                </View>
              );
            })}
            <BodyText tone="secondary">{t('bands.hint')}</BodyText>
          </Card>

          <AppButton label={t('core:common.save')} onPress={() => void handleSave()} isBusy={isSaving} />
        </>
      ) : null}
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}
      <BodyText tone="secondary" style={styles.privacyNote}>
        {t('privacy')}
      </BodyText>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  phaseText: { fontSize: 18, fontWeight: '600', textAlign: 'center' },
  centeredText: { textAlign: 'center' },
  mainValue: { fontSize: 40, fontWeight: '700', textAlign: 'center', fontVariant: ['tabular-nums'] },
  tableRow: { flexDirection: 'row', paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  tableCell: { flex: 1, textAlign: 'center', fontVariant: ['tabular-nums'] },
  privacyNote: { fontSize: 13 },
});
