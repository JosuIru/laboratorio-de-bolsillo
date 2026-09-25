import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import { AppButton, BodyText, Card, ScreenContainer, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { estimateLocation, parseReceiverRows, type ReceiverRow } from './locationEstimate';
import { LocatorPlane, type PlaneHyperbola } from './LocatorPlane';
import {
  clampTemperatureCelsius,
  defaultTemperatureCelsius,
  type LayoutPreset,
  layoutPresetPositions,
  layoutPresets,
  maximumReceiverCount,
  minimumReceiverCount,
  receiverLabels,
  soundLocatorInstrumentId,
} from './locatorConfiguration';
import type { SoundLocatorMeasurementValues } from './schema';
import { useClapTiming } from './useClapTiming';

const hyperbolaColors: readonly string[] = ['#D97706', '#16A34A', '#9333EA', '#DB2777', '#0891B2'];

function formatDecimal(value: number, fractionDigits: number): string {
  return value.toFixed(fractionDigits);
}

function rowsForPreset(layoutPreset: LayoutPreset): ReceiverRow[] {
  return layoutPresetPositions[layoutPreset].map((presetPosition) => ({
    xText: String(presetPosition.x),
    yText: String(presetPosition.y),
    intervalText: '',
  }));
}

function ChoiceRow<TOption extends string | number>({
  options,
  selectedOption,
  onSelect,
  labelFor,
}: {
  options: readonly TOption[];
  selectedOption: TOption | null;
  onSelect(option: NoInfer<TOption>): void;
  labelFor(option: NoInfer<TOption>): string;
}) {
  const themePalette = useThemePalette();
  return (
    <View style={styles.choiceRow}>
      {options.map((option) => {
        const isSelected = option === selectedOption;
        return (
          <Pressable
            key={String(option)}
            accessibilityRole="radio"
            accessibilityState={{ selected: isSelected }}
            onPress={() => onSelect(option)}
            style={[styles.choice, { borderColor: isSelected ? themePalette.accent : themePalette.border }]}>
            <BodyText tone={isSelected ? 'accent' : 'primary'} style={styles.choiceLabel}>
              {labelFor(option)}
            </BodyText>
          </Pressable>
        );
      })}
    </View>
  );
}

export function SoundLocatorScreen({ saveMeasurement }: InstrumentScreenProps<SoundLocatorMeasurementValues>) {
  const { t } = useTranslation(soundLocatorInstrumentId);
  const themePalette = useThemePalette();
  const [isListening, setIsListening] = useState(false);
  const [receiverRows, setReceiverRows] = useState<ReceiverRow[]>(() => rowsForPreset('triangle'));
  const [selectedPreset, setSelectedPreset] = useState<LayoutPreset | null>('triangle');
  const [emitterIndex, setEmitterIndex] = useState(0);
  const [temperatureCelsius, setTemperatureCelsius] = useState(defaultTemperatureCelsius);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const { audioStatus, timingState, isEmitting, restartMeasurement, emitReference } = useClapTiming(isListening);
  const ownResult = timingState.phase === 'done' ? timingState.result : null;

  const parsedRows = useMemo(() => parseReceiverRows(receiverRows), [receiverRows]);
  const locationEstimate = useMemo(
    () =>
      parsedRows.status === 'ok'
        ? estimateLocation(parsedRows.receiverPositions, parsedRows.intervalsSeconds, emitterIndex, temperatureCelsius)
        : null,
    [parsedRows, emitterIndex, temperatureCelsius],
  );
  const hyperbolas = useMemo<PlaneHyperbola[]>(() => {
    if (!locationEstimate) return [];
    const { receiverPositions, pseudorangesMeters } = locationEstimate;
    return receiverPositions.slice(1).map((receiverPosition, offsetIndex) => ({
      focusA: receiverPositions[0]!,
      focusB: receiverPosition,
      rangeDifferenceMeters: pseudorangesMeters[offsetIndex + 1]! - pseudorangesMeters[0]!,
      color: hyperbolaColors[offsetIndex % hyperbolaColors.length]!,
    }));
  }, [locationEstimate]);
  const planeReceiverPositions = useMemo(
    () =>
      locationEstimate?.receiverPositions ??
      receiverRows.map((receiverRow) => ({
        x: Number(receiverRow.xText.replace(',', '.')) || 0,
        y: Number(receiverRow.yText.replace(',', '.')) || 0,
      })),
    [locationEstimate, receiverRows],
  );
  const solution = locationEstimate?.solution ?? null;

  function updateRow(rowIndex: number, changedFields: Partial<ReceiverRow>) {
    setReceiverRows((previousRows) =>
      previousRows.map((receiverRow, currentIndex) =>
        currentIndex === rowIndex ? { ...receiverRow, ...changedFields } : receiverRow,
      ),
    );
    if (changedFields.xText !== undefined || changedFields.yText !== undefined) setSelectedPreset(null);
  }

  function applyPreset(layoutPreset: LayoutPreset) {
    setSelectedPreset(layoutPreset);
    setReceiverRows((previousRows) =>
      rowsForPreset(layoutPreset).map((presetRow, rowIndex) => ({
        ...presetRow,
        intervalText: previousRows[rowIndex]?.intervalText ?? '',
      })),
    );
    setEmitterIndex((previousIndex) => Math.min(previousIndex, layoutPresetPositions[layoutPreset].length - 1));
  }

  function addReceiver() {
    setReceiverRows((previousRows) => [...previousRows, { xText: '', yText: '', intervalText: '' }]);
    setSelectedPreset(null);
  }

  function removeLastReceiver() {
    setReceiverRows((previousRows) => previousRows.slice(0, -1));
    setEmitterIndex((previousIndex) => Math.min(previousIndex, receiverRows.length - 2));
    setSelectedPreset(null);
  }

  async function handleSave() {
    if (!locationEstimate || !solution) return;
    setIsSaving(true);
    setStatusMessage(null);
    const roundTo = (value: number, fractionDigits: number) => Math.round(value * 10 ** fractionDigits) / 10 ** fractionDigits;
    try {
      await saveMeasurement({
        values: {
          positionXMeters: roundTo(solution.position.x, 3),
          positionYMeters: roundTo(solution.position.y, 3),
          errorSemiMajorAxisMeters: roundTo(solution.errorEllipse?.semiMajorAxisMeters ?? 0, 3),
          errorSemiMinorAxisMeters: roundTo(solution.errorEllipse?.semiMinorAxisMeters ?? 0, 3),
          errorOrientationDegrees: roundTo(((solution.errorEllipse?.orientationRadians ?? 0) * 180) / Math.PI, 1),
          rootMeanSquareResidualMeters: roundTo(solution.rootMeanSquareResidualMeters, 4),
          isAmbiguous: solution.alternativePosition !== null,
          receiverCount: locationEstimate.receiverPositions.length,
          emitterIndex,
          temperatureCelsius,
          speedOfSoundMetersPerSecond: roundTo(locationEstimate.speedOfSoundMetersPerSecond, 1),
          receiverXMeters: locationEstimate.receiverPositions.map((position) => position.x),
          receiverYMeters: locationEstimate.receiverPositions.map((position) => position.y),
          intervalsMilliseconds: locationEstimate.intervalsSeconds.map((intervalSeconds) => roundTo(intervalSeconds * 1000, 3)),
        },
      });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  function renderTimingStatus() {
    if (audioStatus.status === 'idle') return <BodyText tone="secondary">{t('timing.idle')}</BodyText>;
    if (audioStatus.status === 'starting') return <BodyText tone="secondary">{t('timing.starting')}</BodyText>;
    if (audioStatus.status === 'error') {
      return <BodyText tone="danger">{t('core:common.error', { message: audioStatus.errorMessage })}</BodyText>;
    }
    switch (timingState.phase) {
      case 'waitingForChirp':
        return <BodyText style={styles.statusHeadline}>{t('timing.waitingForChirp')}</BodyText>;
      case 'capturing':
        return (
          <>
            <BodyText tone="accent" style={styles.statusHeadline}>
              {t('timing.clapNow')}
            </BodyText>
            <View style={[styles.progressTrack, { backgroundColor: themePalette.border }]}>
              <View
                style={[
                  styles.progressFill,
                  { backgroundColor: themePalette.accent, width: `${Math.round(timingState.progress * 100)}%` },
                ]}
              />
            </View>
          </>
        );
      case 'failed':
        return <BodyText tone="danger">{t(`timing.failures.${timingState.reason}`)}</BodyText>;
      case 'done': {
        const { result } = timingState;
        return (
          <>
            <BodyText tone="secondary" style={styles.smallText}>
              {t('timing.intervalLabel')}
            </BodyText>
            <View accessibilityLiveRegion="polite">
              <BodyText tone="accent" style={styles.intervalValue}>
                {formatDecimal(result.intervalSeconds * 1000, 2)}
              </BodyText>
            </View>
            <BodyText tone="secondary" style={styles.centeredText}>
              {t('timing.intervalUnit')}
            </BodyText>
            <BodyText tone="secondary" style={styles.smallText}>
              {result.clockDriftPartsPerMillion === null
                ? t('timing.noDriftCorrection')
                : t('timing.driftCorrected', { drift: formatDecimal(result.clockDriftPartsPerMillion, 0) })}
            </BodyText>
            <BodyText tone="secondary" style={styles.smallText}>
              {t('timing.quality', {
                chirp: formatDecimal(result.chirpSharpness, 0),
                clap: formatDecimal(result.clapSignalToNoiseRatio, 0),
              })}
            </BodyText>
            {result.hasCompetingOnset ? (
              <BodyText tone="danger" style={styles.smallText}>
                {t('timing.competingOnset')}
              </BodyText>
            ) : null}
            {result.clapPeakAmplitude > 0.98 ? (
              <BodyText tone="danger" style={styles.smallText}>
                {t('timing.clipped')}
              </BodyText>
            ) : null}
          </>
        );
      }
    }
  }

  const isAudioReady = audioStatus.status === 'listening';
  const inputStyle = [styles.input, { color: themePalette.textPrimary, borderColor: themePalette.border }];

  return (
    <ScreenContainer>
      <Card>
        <BodyText style={styles.cardTitle}>{t('howTo.title')}</BodyText>
        {(['step1', 'step2', 'step3', 'step4'] as const).map((stepKey) => (
          <BodyText key={stepKey} tone="secondary" style={styles.smallText}>
            {t(`howTo.${stepKey}`)}
          </BodyText>
        ))}
      </Card>

      <SectionTitle>{t('timing.title')}</SectionTitle>
      <AppButton
        label={isListening ? t('timing.stopListening') : t('timing.startListening')}
        onPress={() => setIsListening((wasListening) => !wasListening)}
        variant={isListening ? 'secondary' : 'primary'}
      />
      <Card style={styles.timingCard}>{renderTimingStatus()}</Card>
      {isListening ? (
        <View style={styles.buttonRow}>
          <View style={styles.buttonCell}>
            <AppButton
              label={isEmitting ? t('timing.emitting') : t('timing.emit')}
              onPress={emitReference}
              variant="secondary"
              isDisabled={!isAudioReady || isEmitting || timingState.phase !== 'waitingForChirp'}
            />
          </View>
          <View style={styles.buttonCell}>
            <AppButton
              label={t('timing.again')}
              onPress={restartMeasurement}
              variant="secondary"
              isDisabled={!isAudioReady || timingState.phase === 'waitingForChirp'}
            />
          </View>
        </View>
      ) : null}
      <BodyText tone="secondary" style={styles.smallText}>
        {t('timing.help')}
      </BodyText>

      <SectionTitle>{t('solve.title')}</SectionTitle>
      <Card>
        <BodyText>{t('solve.layout')}</BodyText>
        <ChoiceRow
          options={layoutPresets}
          selectedOption={selectedPreset}
          onSelect={applyPreset}
          labelFor={(layoutPreset) => t(`layouts.${layoutPreset}`)}
        />
        <BodyText tone="secondary" style={styles.smallText}>
          {t('solve.layoutHelp')}
        </BodyText>

        <View style={styles.tableHeader}>
          <View style={styles.labelCell} />
          <BodyText tone="secondary" style={styles.coordinateHeader}>
            {t('solve.columnX')}
          </BodyText>
          <BodyText tone="secondary" style={styles.coordinateHeader}>
            {t('solve.columnY')}
          </BodyText>
          <BodyText tone="secondary" style={styles.intervalHeader}>
            {t('solve.columnInterval')}
          </BodyText>
          <View style={styles.ownButtonCell} />
        </View>
        {receiverRows.map((receiverRow, rowIndex) => (
          <View key={rowIndex} style={styles.tableRow}>
            <BodyText style={styles.receiverLabel}>{receiverLabels[rowIndex]}</BodyText>
            <TextInput
              value={receiverRow.xText}
              onChangeText={(xText) => updateRow(rowIndex, { xText })}
              keyboardType="numbers-and-punctuation"
              accessibilityLabel={t('solve.xAccessibility', { receiver: receiverLabels[rowIndex] })}
              style={[inputStyle, styles.coordinateCell]}
            />
            <TextInput
              value={receiverRow.yText}
              onChangeText={(yText) => updateRow(rowIndex, { yText })}
              keyboardType="numbers-and-punctuation"
              accessibilityLabel={t('solve.yAccessibility', { receiver: receiverLabels[rowIndex] })}
              style={[inputStyle, styles.coordinateCell]}
            />
            <TextInput
              value={receiverRow.intervalText}
              onChangeText={(intervalText) => updateRow(rowIndex, { intervalText })}
              keyboardType="decimal-pad"
              placeholder="ms"
              placeholderTextColor={themePalette.textSecondary}
              accessibilityLabel={t('solve.intervalAccessibility', { receiver: receiverLabels[rowIndex] })}
              style={[inputStyle, styles.intervalCell]}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('solve.useOwnAccessibility', { receiver: receiverLabels[rowIndex] })}
              disabled={!ownResult}
              onPress={() =>
                ownResult && updateRow(rowIndex, { intervalText: formatDecimal(ownResult.intervalSeconds * 1000, 2) })
              }
              style={[styles.ownButtonCell, { opacity: ownResult ? 1 : 0.35 }]}
              hitSlop={6}>
              <BodyText tone="accent" style={styles.smallText}>
                {t('solve.useOwn')}
              </BodyText>
            </Pressable>
          </View>
        ))}
        <View style={styles.buttonRow}>
          <View style={styles.buttonCell}>
            <AppButton
              label={t('solve.addReceiver')}
              onPress={addReceiver}
              variant="secondary"
              isDisabled={receiverRows.length >= maximumReceiverCount}
            />
          </View>
          <View style={styles.buttonCell}>
            <AppButton
              label={t('solve.removeReceiver')}
              onPress={removeLastReceiver}
              variant="secondary"
              isDisabled={receiverRows.length <= minimumReceiverCount}
            />
          </View>
        </View>

        <BodyText>{t('solve.emitter')}</BodyText>
        <ChoiceRow
          options={receiverRows.map((_, rowIndex) => rowIndex)}
          selectedOption={emitterIndex}
          onSelect={setEmitterIndex}
          labelFor={(rowIndex) => receiverLabels[rowIndex] ?? String(rowIndex)}
        />

        <BodyText>{t('solve.temperature')}</BodyText>
        <View style={styles.temperatureRow}>
          <View style={styles.stepButton}>
            <AppButton
              label="−"
              variant="secondary"
              onPress={() => setTemperatureCelsius((previous) => clampTemperatureCelsius(previous - 1))}
            />
          </View>
          <BodyText style={styles.temperatureValue}>{`${temperatureCelsius} °C`}</BodyText>
          <View style={styles.stepButton}>
            <AppButton
              label="+"
              variant="secondary"
              onPress={() => setTemperatureCelsius((previous) => clampTemperatureCelsius(previous + 1))}
            />
          </View>
        </View>
      </Card>

      <LocatorPlane
        receiverPositions={planeReceiverPositions}
        receiverLabels={receiverLabels}
        emitterIndex={emitterIndex}
        hyperbolas={hyperbolas}
        estimatedPosition={solution?.position ?? null}
        errorEllipse={solution?.errorEllipse ?? null}
        alternativePosition={solution?.alternativePosition ?? null}
        accessibilityLabel={
          solution
            ? t('plane.accessibilityWithResult', {
                x: formatDecimal(solution.position.x, 2),
                y: formatDecimal(solution.position.y, 2),
              })
            : t('plane.accessibility')
        }
      />
      <BodyText tone="secondary" style={styles.smallText}>
        {t('plane.legend')}
      </BodyText>

      <Card style={styles.resultCard}>
        {parsedRows.status === 'incomplete' ? <BodyText tone="secondary">{t('solve.incomplete')}</BodyText> : null}
        {parsedRows.status === 'duplicatePositions' ? (
          <BodyText tone="danger">{t('solve.duplicatePositions')}</BodyText>
        ) : null}
        {locationEstimate && !solution ? <BodyText tone="danger">{t('solve.noSolution')}</BodyText> : null}
        {locationEstimate && solution ? (
          <>
            <BodyText tone="accent" style={styles.positionValue}>
              {t('result.position', {
                x: formatDecimal(solution.position.x, 2),
                y: formatDecimal(solution.position.y, 2),
              })}
            </BodyText>
            <BodyText tone="secondary" style={styles.smallText}>
              {solution.errorEllipse
                ? t('result.ellipse', {
                    major: formatDecimal(solution.errorEllipse.semiMajorAxisMeters * 100, 0),
                    minor: formatDecimal(solution.errorEllipse.semiMinorAxisMeters * 100, 0),
                  })
                : t('result.degenerate')}
            </BodyText>
            <BodyText tone="secondary" style={styles.smallText}>
              {locationEstimate.receiverPositions.length > 3
                ? t('result.residual', { residual: formatDecimal(solution.rootMeanSquareResidualMeters * 100, 1) })
                : t('result.noRedundancy')}
            </BodyText>
            {solution.alternativePosition ? (
              <BodyText tone="danger" style={styles.smallText}>
                {t('result.ambiguous', {
                  x: formatDecimal(solution.alternativePosition.x, 2),
                  y: formatDecimal(solution.alternativePosition.y, 2),
                })}
              </BodyText>
            ) : null}
            {locationEstimate.impossibleReceiverIndices.length > 0 ? (
              <BodyText tone="danger" style={styles.smallText}>
                {t('result.impossible', {
                  receivers: locationEstimate.impossibleReceiverIndices
                    .map((receiverIndex) => receiverLabels[receiverIndex])
                    .join(', '),
                })}
              </BodyText>
            ) : null}
            {locationEstimate.isInconsistent ? (
              <BodyText tone="danger" style={styles.smallText}>
                {t('result.inconsistent')}
              </BodyText>
            ) : null}
            {locationEstimate.isFarOutside ? (
              <BodyText tone="danger" style={styles.smallText}>
                {t('result.farOutside')}
              </BodyText>
            ) : null}
            <AppButton label={t('core:common.save')} onPress={() => void handleSave()} isBusy={isSaving} />
          </>
        ) : null}
        {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}
      </Card>

      <BodyText tone="secondary" style={styles.smallText}>
        {t('honestyNote')}
      </BodyText>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  cardTitle: { fontWeight: '600' },
  smallText: { fontSize: 13 },
  centeredText: { textAlign: 'center' },
  statusHeadline: { fontSize: 18, fontWeight: '600', textAlign: 'center' },
  timingCard: { alignItems: 'stretch', paddingVertical: 18, gap: 6 },
  intervalValue: { fontSize: 56, lineHeight: 64, fontWeight: '700', fontVariant: ['tabular-nums'], textAlign: 'center' },
  positionValue: { fontSize: 24, fontWeight: '700', fontVariant: ['tabular-nums'] },
  resultCard: { gap: 6 },
  progressTrack: { height: 10, borderRadius: 5, overflow: 'hidden' },
  progressFill: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonCell: { flex: 1 },
  choiceRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  choice: { flexGrow: 1, minWidth: 44, alignItems: 'center', paddingVertical: 10, borderRadius: 10, borderWidth: 1.5 },
  choiceLabel: { fontSize: 14, textAlign: 'center' },
  tableHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tableRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  labelCell: { width: 18 },
  receiverLabel: { width: 18, fontWeight: '700' },
  coordinateCell: { flex: 2 },
  intervalCell: { flex: 3 },
  coordinateHeader: { flex: 2, fontSize: 13 },
  intervalHeader: { flex: 3, fontSize: 13 },
  ownButtonCell: { width: 44, alignItems: 'center' },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 8,
    fontSize: 16,
    fontVariant: ['tabular-nums'],
  },
  temperatureRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  temperatureValue: { flex: 1, textAlign: 'center', fontSize: 20, fontVariant: ['tabular-nums'] },
  stepButton: { width: 56 },
});
