import { randomUUID } from 'expo-crypto';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, StyleSheet, TextInput, View } from 'react-native';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import { formatBandCenter } from '@/processing/dsp/frequencyBands';
import {
  compareFingerprints,
  type DiagnosisResult,
  type DomainFingerprint,
  type MachineFingerprint,
  maximumBaselineRecordingCount,
} from '@/processing/diagnostics/machineFingerprint';
import { SignalChart } from '@/ui/charts/SignalChart';
import { AppButton, BodyText, Card, ScreenContainer, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { loadMachines, machineWithBaselineRecordings, type MonitoredMachine, saveMachines } from './machineStorage';
import type { MachineDiagnosisMeasurementValues } from './schema';
import { captureDurationSeconds, useFingerprintCapture } from './useFingerprintCapture';

export const machineDiagnosisInstrumentId = 'machine-diagnosis';

/** `baseline` empieza la huella de cero; `extraBaseline` le añade otra grabación. */
type CapturePurpose = 'baseline' | 'extraBaseline' | 'comparison';

/** Con menos grabaciones no se sabe qué variación entre medidas es normal. */
const recommendedBaselineRecordingCount = 3;

const shownDeviationCount = 5;

/** Diferencia por banda entre dos huellas del mismo dominio, en el orden de la huella base. */
function bandDeltas(baseline: DomainFingerprint | null, current: DomainFingerprint | null): Float64Array | null {
  if (!baseline || !current || baseline.bandLevelsDecibels.length !== current.bandLevelsDecibels.length) return null;
  return Float64Array.from(baseline.bandLevelsDecibels, (baselineLevel, bandIndex) =>
    // Recorta por abajo para que las bandas en silencio no dominen la gráfica.
    Math.max(-20, Math.min(20, current.bandLevelsDecibels[bandIndex]! - baselineLevel)),
  );
}

export function MachineDiagnosisScreen({ saveMeasurement }: InstrumentScreenProps<MachineDiagnosisMeasurementValues>) {
  const { t, i18n } = useTranslation(machineDiagnosisInstrumentId);
  const themePalette = useThemePalette();
  const [machines, setMachines] = useState<MonitoredMachine[]>(loadMachines);
  const [selectedMachineId, setSelectedMachineId] = useState<string | null>(() => loadMachines()[0]?.id ?? null);
  const [newMachineName, setNewMachineName] = useState('');
  const [capturePurpose, setCapturePurpose] = useState<CapturePurpose | null>(null);
  const [latestComparison, setLatestComparison] = useState<{
    diagnosis: DiagnosisResult;
    current: MachineFingerprint;
  } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const selectedMachine = machines.find((machine) => machine.id === selectedMachineId) ?? null;

  function updateMachines(updatedMachines: MonitoredMachine[]) {
    setMachines(updatedMachines);
    saveMachines(updatedMachines);
  }

  // Al terminar una grabación: guarda la huella base o compara con ella.
  function handleCaptureComplete(fingerprint: MachineFingerprint) {
    if (!selectedMachine || !capturePurpose) return;
    if (capturePurpose === 'baseline' || capturePurpose === 'extraBaseline') {
      const baselineRecordings =
        capturePurpose === 'baseline' ? [fingerprint] : [...selectedMachine.baselineRecordings, fingerprint];
      updateMachines(
        machines.map((machine) =>
          machine.id === selectedMachine.id ? machineWithBaselineRecordings(machine, baselineRecordings) : machine,
        ),
      );
    } else if (selectedMachine.baseline) {
      setLatestComparison({ diagnosis: compareFingerprints(selectedMachine.baseline, fingerprint), current: fingerprint });
    }
    setCapturePurpose(null);
  }

  const { captureState, microphoneStatus, startCapture, cancelCapture } = useFingerprintCapture({
    onCaptureComplete: handleCaptureComplete,
  });

  function beginCapture(purpose: CapturePurpose) {
    setStatusMessage(null);
    setLatestComparison(null);
    setCapturePurpose(purpose);
    startCapture();
  }

  function handleCreateMachine() {
    const machineName = newMachineName.trim();
    if (!machineName) return;
    const createdMachine: MonitoredMachine = { id: randomUUID(), name: machineName, baselineRecordings: [], baseline: null };
    updateMachines([...machines, createdMachine]);
    setSelectedMachineId(createdMachine.id);
    setNewMachineName('');
    setLatestComparison(null);
  }

  function handleDeleteMachine() {
    if (!selectedMachine) return;
    const deletedMachineId = selectedMachine.id;
    Alert.alert(t('machines.deleteTitle', { name: selectedMachine.name }), t('machines.deleteMessage'), [
      { text: t('core:common.cancel'), style: 'cancel' },
      {
        text: t('machines.delete'),
        style: 'destructive',
        onPress: () => {
          const remainingMachines = machines.filter((machine) => machine.id !== deletedMachineId);
          updateMachines(remainingMachines);
          setSelectedMachineId(remainingMachines[0]?.id ?? null);
          setLatestComparison(null);
        },
      },
    ]);
  }

  /** Volver a grabar la huella borra la anterior: se pide confirmación. */
  function handleRerecordBaseline() {
    Alert.alert(t('capture.rerecordTitle'), t('capture.rerecordMessage'), [
      { text: t('core:common.cancel'), style: 'cancel' },
      { text: t('capture.rerecordBaseline'), style: 'destructive', onPress: () => beginCapture('baseline') },
    ]);
  }

  function describeBand(domain: 'audio' | 'vibration', centerHz: number) {
    return t(`domain.${domain}`, { band: formatBandCenter(centerHz) });
  }

  async function handleSaveComparison() {
    if (!latestComparison || !selectedMachine?.baseline) return;
    const { diagnosis, current } = latestComparison;
    const mostChanged = diagnosis.bandDeviations[0];
    setIsSaving(true);
    try {
      await saveMeasurement({
        values: {
          machineName: selectedMachine.name,
          verdict: diagnosis.verdict,
          largestIncreaseDecibels: diagnosis.largestIncreaseDecibels,
          ...(mostChanged && mostChanged.deltaDecibels > 0
            ? { mostChangedBand: `${describeBand(mostChanged.domain, mostChanged.centerHz)} (+${mostChanged.deltaDecibels.toFixed(1)} dB)` }
            : {}),
          ...(diagnosis.overallDeltaDecibels.audio !== null
            ? { audioOverallDeltaDecibels: diagnosis.overallDeltaDecibels.audio }
            : {}),
          ...(diagnosis.overallDeltaDecibels.vibration !== null
            ? { vibrationOverallDeltaDecibels: diagnosis.overallDeltaDecibels.vibration }
            : {}),
          baselineCapturedAt: selectedMachine.baseline.capturedAt,
          captureDurationSeconds: current.durationSeconds,
          audioBandCentersHz: current.audio?.bandCentersHz.map((centerHz) => Math.round(centerHz * 100) / 100) ?? [],
          audioBandLevelsDecibels: current.audio?.bandLevelsDecibels ?? [],
          vibrationBandCentersHz: current.vibration?.bandCentersHz.map((centerHz) => Math.round(centerHz * 100) / 100) ?? [],
          vibrationBandLevelsDecibels: current.vibration?.bandLevelsDecibels ?? [],
        },
      });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  const isCapturing = captureState.status === 'capturing';
  const verdictColors = { normal: themePalette.success, watch: '#B7791F', alert: themePalette.danger } as const;
  const audioDeltas = latestComparison ? bandDeltas(selectedMachine?.baseline?.audio ?? null, latestComparison.current.audio) : null;
  const vibrationDeltas = latestComparison
    ? bandDeltas(selectedMachine?.baseline?.vibration ?? null, latestComparison.current.vibration)
    : null;

  return (
    <ScreenContainer>
      <BodyText tone="secondary">{t('instructions')}</BodyText>

      <SectionTitle>{t('machines.title')}</SectionTitle>
      <View style={styles.chipRow}>
        {machines.map((machine) => {
          const isSelectedMachine = machine.id === selectedMachineId;
          return (
            <Pressable
              key={machine.id}
              accessibilityRole="radio"
              accessibilityState={{ selected: isSelectedMachine }}
              disabled={isCapturing}
              onPress={() => {
                setSelectedMachineId(machine.id);
                setLatestComparison(null);
              }}
              style={[styles.chip, { borderColor: isSelectedMachine ? themePalette.accent : themePalette.border }]}>
              <BodyText tone={isSelectedMachine ? 'accent' : 'primary'}>{machine.name}</BodyText>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.inputRow}>
        <TextInput
          value={newMachineName}
          onChangeText={setNewMachineName}
          placeholder={t('machines.newPlaceholder')}
          placeholderTextColor={themePalette.textSecondary}
          style={[styles.input, { color: themePalette.textPrimary, borderColor: themePalette.border }]}
        />
        <AppButton label={t('machines.create')} onPress={handleCreateMachine} variant="secondary" isDisabled={!newMachineName.trim()} />
      </View>

      {selectedMachine ? (
        <Card>
          <BodyText style={styles.machineName}>{selectedMachine.name}</BodyText>
          <BodyText tone="secondary">
            {selectedMachine.baseline
              ? t('baseline.recordedAt', {
                  date: new Date(selectedMachine.baseline.capturedAt).toLocaleString(i18n.language),
                  count: selectedMachine.baselineRecordings.length,
                })
              : t('baseline.missing')}
          </BodyText>
          {selectedMachine.baseline && selectedMachine.baselineRecordings.length < recommendedBaselineRecordingCount ? (
            <BodyText tone="secondary">
              {t('baseline.addMoreHint', { recommended: recommendedBaselineRecordingCount })}
            </BodyText>
          ) : null}

          {isCapturing ? (
            <View style={styles.captureBlock}>
              <BodyText>{t(capturePurpose === 'comparison' ? 'capture.recordingComparison' : 'capture.recordingBaseline')}</BodyText>
              <View style={[styles.progressTrack, { backgroundColor: themePalette.border }]}>
                <View
                  style={[
                    styles.progressFill,
                    { backgroundColor: themePalette.accent, width: `${Math.round(captureState.progress * 100)}%` },
                  ]}
                />
              </View>
              <BodyText tone="secondary">{t('capture.hint', { seconds: captureDurationSeconds })}</BodyText>
              {microphoneStatus.status === 'error' ? (
                <BodyText tone="danger">{t('capture.microphoneError', { message: microphoneStatus.errorMessage })}</BodyText>
              ) : null}
              <AppButton label={t('core:common.cancel')} onPress={cancelCapture} variant="secondary" />
            </View>
          ) : (
            <View style={styles.captureBlock}>
              {selectedMachine.baseline ? (
                <AppButton label={t('capture.compare')} onPress={() => beginCapture('comparison')} />
              ) : null}
              {selectedMachine.baseline && selectedMachine.baselineRecordings.length < maximumBaselineRecordingCount ? (
                <AppButton
                  label={t('capture.addBaselineRecording')}
                  onPress={() => beginCapture('extraBaseline')}
                  variant={selectedMachine.baselineRecordings.length < recommendedBaselineRecordingCount ? 'primary' : 'secondary'}
                />
              ) : null}
              <AppButton
                label={t(selectedMachine.baseline ? 'capture.rerecordBaseline' : 'capture.recordBaseline')}
                onPress={selectedMachine.baseline ? handleRerecordBaseline : () => beginCapture('baseline')}
                variant={selectedMachine.baseline ? 'secondary' : 'primary'}
              />
              {captureState.status === 'error' ? <BodyText tone="danger">{t('capture.noData')}</BodyText> : null}
            </View>
          )}
        </Card>
      ) : (
        <Card>
          <BodyText tone="secondary">{t('machines.empty')}</BodyText>
        </Card>
      )}

      {latestComparison ? (
        <Card>
          <View style={[styles.verdictBadge, { backgroundColor: verdictColors[latestComparison.diagnosis.verdict] }]}>
            <BodyText style={styles.verdictText}>{t(`verdict.${latestComparison.diagnosis.verdict}`)}</BodyText>
          </View>
          <BodyText tone="secondary">{t(`verdictHint.${latestComparison.diagnosis.verdict}`)}</BodyText>
          {(['audio', 'vibration'] as const).map((domain) => {
            const overallDelta = latestComparison.diagnosis.overallDeltaDecibels[domain];
            return overallDelta !== null ? (
              <BodyText key={domain}>
                {t(`overall.${domain}`, { delta: `${overallDelta >= 0 ? '+' : ''}${overallDelta.toFixed(1)}` })}
              </BodyText>
            ) : null;
          })}
          <BodyText style={styles.subtitle}>{t('deviations.title')}</BodyText>
          {latestComparison.diagnosis.bandDeviations.slice(0, shownDeviationCount).map((deviation) => (
            <BodyText key={`${deviation.domain}-${deviation.centerHz}`}>
              {`${describeBand(deviation.domain, deviation.centerHz)}: ${deviation.deltaDecibels >= 0 ? '+' : ''}${deviation.deltaDecibels.toFixed(1)} dB`}
            </BodyText>
          ))}
          {audioDeltas ? (
            <>
              <BodyText style={styles.subtitle}>{t('charts.audio')}</BodyText>
              <SignalChart
                series={[{ values: audioDeltas, color: themePalette.accent }]}
                height={100}
                verticalRange={{ mode: 'symmetric', minimumHalfRange: 6 }}
                revision={latestComparison.current.capturedAt}
                unitLabel="dB"
                horizontalLabels={[`${formatBandCenter(latestComparison.current.audio!.bandCentersHz[0]!)} Hz`, `${formatBandCenter(latestComparison.current.audio!.bandCentersHz.at(-1)!)} Hz`]}
                accessibilityLabel={t('charts.audio')}
              />
            </>
          ) : null}
          {vibrationDeltas ? (
            <>
              <BodyText style={styles.subtitle}>{t('charts.vibration')}</BodyText>
              <SignalChart
                series={[{ values: vibrationDeltas, color: '#C2410C' }]}
                height={100}
                verticalRange={{ mode: 'symmetric', minimumHalfRange: 6 }}
                revision={latestComparison.current.capturedAt}
                unitLabel="dB"
                horizontalLabels={[`${formatBandCenter(latestComparison.current.vibration!.bandCentersHz[0]!)} Hz`, `${formatBandCenter(latestComparison.current.vibration!.bandCentersHz.at(-1)!)} Hz`]}
                accessibilityLabel={t('charts.vibration')}
              />
            </>
          ) : null}
          <AppButton label={t('core:common.save')} onPress={() => void handleSaveComparison()} isBusy={isSaving} />
          {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}
        </Card>
      ) : null}

      {selectedMachine && !isCapturing ? (
        <AppButton label={t('machines.delete')} onPress={handleDeleteMachine} variant="danger" />
      ) : null}
      <BodyText tone="secondary" style={styles.privacyNote}>
        {t('privacy')}
      </BodyText>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1.5 },
  inputRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: { flex: 1, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  machineName: { fontSize: 18, fontWeight: '600' },
  captureBlock: { gap: 8, marginTop: 8 },
  progressTrack: { height: 8, borderRadius: 4, overflow: 'hidden' },
  progressFill: { height: 8, borderRadius: 4 },
  verdictBadge: { alignSelf: 'flex-start', paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8 },
  verdictText: { color: '#FFFFFF', fontWeight: '700' },
  subtitle: { fontWeight: '600', marginTop: 8 },
  privacyNote: { fontSize: 13 },
});
