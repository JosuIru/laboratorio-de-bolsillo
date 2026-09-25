import { File, Paths } from 'expo-file-system';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Share, StyleSheet, TextInput, View } from 'react-native';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import { AppButton, BodyText, Card } from '@/ui/components';
import { parseDecimalInput } from '@/ui/decimalInput';
import { useThemePalette } from '@/ui/theme';

import type { SeismicNetworkMeasurementValues } from './schema';
import { seismicNetworkInstrumentId } from './seismicNetworkConfiguration';
import { buildStationCodeLine, formatDecimal } from './stationMessages';
import { useSeismicStation } from './useSeismicStation';
import { formatStationWaveformCsv } from './waveformCsv';

/** Cociente STA/LTA de disparo por nivel de sensibilidad. */
const triggerRatioBySensitivity = { high: 5, medium: 8, low: 15 } as const;
type SensitivityLevel = keyof typeof triggerRatioBySensitivity;
/** Por debajo de esta frecuencia el error de cronometraje (≈ 2 muestras) pasa de 10 ms. */
const lowSampleRateWarningHz = 200;

type StationPanelProps = Pick<InstrumentScreenProps<SeismicNetworkMeasurementValues>, 'saveMeasurement'>;

export function StationPanel({ saveMeasurement }: StationPanelProps) {
  const { t } = useTranslation(seismicNetworkInstrumentId);
  const themePalette = useThemePalette();
  const [stationName, setStationName] = useState('A');
  const [xText, setXText] = useState('0');
  const [yText, setYText] = useState('0');
  const [sensitivityLevel, setSensitivityLevel] = useState<SensitivityLevel>('medium');
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const triggerRatio = triggerRatioBySensitivity[sensitivityLevel];

  const { stage, recordedArrivals, liveRatio, detectorPhase, sampleRateHz, startSync, arm, clearArrivals, stop } =
    useSeismicStation({ isEnabled: true, triggerRatio });

  const stationXMeters = parseDecimalInput(xText);
  const stationYMeters = parseDecimalInput(yText);
  const hasValidPosition = stationXMeters !== null && stationYMeters !== null;
  const latestArrival = recordedArrivals[0] ?? null;
  const timingResolutionMilliseconds = sampleRateHz ? (2 * 1000) / sampleRateHz : null;

  async function handleShare() {
    if (!latestArrival || !hasValidPosition) return;
    const codeLine = buildStationCodeLine({
      stationName,
      xMeters: stationXMeters,
      yMeters: stationYMeters,
      arrivalSeconds: latestArrival.arrivalSeconds,
    });
    const readableLine = t('station.shareText', {
      name: stationName,
      x: formatDecimal(stationXMeters, 2),
      y: formatDecimal(stationYMeters, 2),
      arrival: formatDecimal(latestArrival.arrivalSeconds, 4),
    });
    await Share.share({ message: `${readableLine}\n${codeLine}` });
  }

  async function handleSave() {
    // Se guarda la ventana copiada al detectar el golpe (−1 s / +2 s), no el historial vivo, que
    // solo cubre unos segundos y ya no contendría el golpe.
    const arrivalWaveform = latestArrival?.waveform;
    if (!latestArrival || !arrivalWaveform || !hasValidPosition) return;
    setIsSaving(true);
    setStatusMessage(null);
    try {
      const waveformFile = new File(Paths.cache, `seismic-station-${Date.now()}.csv`);
      waveformFile.create({ overwrite: true });
      waveformFile.write(
        formatStationWaveformCsv(
          arrivalWaveform.timestamps,
          arrivalWaveform.accelerationX,
          arrivalWaveform.accelerationY,
          arrivalWaveform.accelerationZ,
          arrivalWaveform.syncTimestampSeconds,
        ),
      );
      await saveMeasurement({
        values: {
          role: 'station',
          stationName,
          stationXMeters,
          stationYMeters,
          arrivalSeconds: latestArrival.arrivalSeconds,
          ...(sampleRateHz ? { sampleRateHz } : {}),
          triggerRatio,
        },
        attachments: [
          {
            kind: 'series',
            sourceUri: waveformFile.uri,
            fileName: 'estacion.csv',
            mimeType: 'text/csv',
            metadata: { sampleCount: arrivalWaveform.timestamps.length, ...(sampleRateHz ? { sampleRateHz } : {}) },
          },
        ],
      });
      waveformFile.delete();
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  const inputStyle = [styles.input, { color: themePalette.textPrimary, borderColor: themePalette.border }];
  const ratioFraction = Math.min(1, Math.log10(Math.max(1, liveRatio)) / Math.log10(triggerRatio));

  return (
    <>
      <Card>
        <BodyText style={styles.sectionLabel}>{t('station.identity')}</BodyText>
        <View style={styles.inputRow}>
          <View style={styles.inputCellWide}>
            <BodyText tone="secondary" style={styles.inputLabel}>
              {t('station.name')}
            </BodyText>
            <TextInput value={stationName} onChangeText={setStationName} maxLength={16} style={inputStyle} />
          </View>
          <View style={styles.inputCell}>
            <BodyText tone="secondary" style={styles.inputLabel}>
              x (m)
            </BodyText>
            <TextInput value={xText} onChangeText={setXText} keyboardType="numbers-and-punctuation" style={inputStyle} />
          </View>
          <View style={styles.inputCell}>
            <BodyText tone="secondary" style={styles.inputLabel}>
              y (m)
            </BodyText>
            <TextInput value={yText} onChangeText={setYText} keyboardType="numbers-and-punctuation" style={inputStyle} />
          </View>
        </View>
        {!hasValidPosition ? <BodyText tone="danger">{t('station.invalidPosition')}</BodyText> : null}
      </Card>

      {stage === 'idle' ? (
        <Card>
          <BodyText>{t('station.idleHelp')}</BodyText>
          <AppButton label={t('station.startSync')} onPress={startSync} />
        </Card>
      ) : null}

      {stage === 'waiting-sync' ? (
        <Card>
          <BodyText style={styles.stageTitle}>{t('station.waitingSyncTitle')}</BodyText>
          <BodyText tone="secondary">
            {detectorPhase === 'warming-up' ? t('station.keepStill') : t('station.waitingSyncHelp')}
          </BodyText>
        </Card>
      ) : null}

      {stage === 'synced' ? (
        <Card>
          <BodyText style={styles.stageTitle} tone="accent">
            {t('station.syncedTitle')}
          </BodyText>
          <BodyText tone="secondary">{t('station.syncedHelp')}</BodyText>
          <AppButton label={t('station.arm')} onPress={arm} />
        </Card>
      ) : null}

      {stage === 'armed' ? (
        <Card>
          <BodyText tone="secondary">
            {detectorPhase === 'warming-up' ? t('station.keepStill') : t('station.armedHelp')}
          </BodyText>
          <BodyText tone="secondary" style={styles.bigCaption}>
            {t('station.arrivalCaption', { name: stationName })}
          </BodyText>
          <BodyText style={styles.bigArrival}>
            {latestArrival ? `${formatDecimal(latestArrival.arrivalSeconds, 4)} s` : '—'}
          </BodyText>
          {recordedArrivals.length > 1 ? (
            <BodyText tone="secondary">
              {t('station.previousArrivals', {
                list: recordedArrivals
                  .slice(1)
                  .map((recordedArrival) => `${formatDecimal(recordedArrival.arrivalSeconds, 4)} s`)
                  .join(' · '),
              })}
            </BodyText>
          ) : null}
          <View style={styles.buttonRow}>
            <View style={styles.buttonCell}>
              <AppButton
                label={t('station.share')}
                onPress={() => void handleShare()}
                isDisabled={!latestArrival || !hasValidPosition}
              />
            </View>
            <View style={styles.buttonCell}>
              <AppButton
                label={t('core:common.save')}
                onPress={() => void handleSave()}
                isBusy={isSaving}
                isDisabled={!latestArrival?.waveform || !hasValidPosition}
                variant="secondary"
              />
            </View>
          </View>
          {latestArrival && !latestArrival.waveform ? (
            <BodyText tone="secondary">{t('station.capturingWaveform')}</BodyText>
          ) : null}
          <AppButton label={t('station.clearArrivals')} onPress={clearArrivals} variant="secondary" isDisabled={!latestArrival} />
          {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}
        </Card>
      ) : null}

      {stage !== 'idle' ? (
        <>
          <View>
            <BodyText tone="secondary" style={styles.inputLabel}>
              {t('station.levelMeter')}
            </BodyText>
            <View style={[styles.meterTrack, { backgroundColor: themePalette.border }]}>
              <View
                style={[
                  styles.meterFill,
                  { width: `${Math.round(ratioFraction * 100)}%`, backgroundColor: ratioFraction >= 1 ? themePalette.danger : themePalette.accent },
                ]}
              />
            </View>
          </View>
          <BodyText tone={sampleRateHz !== null && sampleRateHz < lowSampleRateWarningHz ? 'danger' : 'secondary'}>
            {sampleRateHz && timingResolutionMilliseconds
              ? t('station.sampleRate', { rate: formatDecimal(sampleRateHz, 0), resolution: formatDecimal(timingResolutionMilliseconds, 1) })
              : t('station.measuringRate')}
          </BodyText>
          <View style={styles.buttonRow}>
            <View style={styles.buttonCell}>
              <AppButton label={t('station.resync')} onPress={startSync} variant="secondary" />
            </View>
            <View style={styles.buttonCell}>
              <AppButton label={t('station.stop')} onPress={stop} variant="danger" />
            </View>
          </View>
        </>
      ) : null}

      <BodyText style={styles.sectionLabel}>{t('station.sensitivity')}</BodyText>
      <View style={styles.segmentedRow}>
        {(Object.keys(triggerRatioBySensitivity) as SensitivityLevel[]).map((level) => {
          const isSelectedLevel = level === sensitivityLevel;
          return (
            <Pressable
              key={level}
              accessibilityRole="radio"
              accessibilityState={{ selected: isSelectedLevel }}
              onPress={() => setSensitivityLevel(level)}
              style={[styles.segment, { borderColor: isSelectedLevel ? themePalette.accent : themePalette.border }]}>
              <BodyText tone={isSelectedLevel ? 'accent' : 'primary'}>{t(`station.sensitivityLevels.${level}`)}</BodyText>
            </Pressable>
          );
        })}
      </View>
      <BodyText tone="secondary">{t('station.limits')}</BodyText>
    </>
  );
}

const styles = StyleSheet.create({
  sectionLabel: { fontWeight: '600' },
  inputRow: { flexDirection: 'row', gap: 8 },
  inputCellWide: { flex: 2, gap: 2 },
  inputCell: { flex: 1, gap: 2 },
  inputLabel: { fontSize: 13 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 16 },
  stageTitle: { fontSize: 18, fontWeight: '700' },
  bigCaption: { textAlign: 'center', marginTop: 4 },
  bigArrival: { fontSize: 52, lineHeight: 60, fontWeight: '700', textAlign: 'center', fontVariant: ['tabular-nums'] },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonCell: { flex: 1 },
  meterTrack: { height: 10, borderRadius: 5, overflow: 'hidden', marginTop: 4 },
  meterFill: { height: 10 },
  segmentedRow: { flexDirection: 'row', gap: 8 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10, borderWidth: 1.5 },
});
