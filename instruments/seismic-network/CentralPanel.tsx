import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import { AppButton, BodyText, Card } from '@/ui/components';
import { parseDecimalInput } from '@/ui/decimalInput';
import { useThemePalette } from '@/ui/theme';

import { analyzeNetwork, buildDemoReadings, type LocationMethod } from './networkAnalysis';
import { type MapStation, NetworkMap, networkMapColors } from './NetworkMap';
import type { SeismicNetworkMeasurementValues } from './schema';
import { defaultTimingUncertaintySeconds, seismicNetworkInstrumentId } from './seismicNetworkConfiguration';
import { formatDecimal, parseStationMessages, type StationReading } from './stationMessages';

interface StationRow {
  rowId: number;
  stationName: string;
  xText: string;
  yText: string;
  arrivalText: string;
}

const locationMethods: readonly LocationMethod[] = ['free', 'known-speed', 'known-source'];
const initialRowCount = 4;

let nextRowId = 1;
function createRow(partialRow: Partial<Omit<StationRow, 'rowId'>> = {}): StationRow {
  return { rowId: nextRowId++, stationName: '', xText: '', yText: '', arrivalText: '', ...partialRow };
}

function rowFromReading(stationReading: StationReading): StationRow {
  return createRow({
    stationName: stationReading.stationName,
    xText: formatDecimal(stationReading.xMeters, 2),
    yText: formatDecimal(stationReading.yMeters, 2),
    arrivalText: formatDecimal(stationReading.arrivalSeconds, 4),
  });
}

function readRow(stationRow: StationRow): StationReading | null {
  const xMeters = parseDecimalInput(stationRow.xText);
  const yMeters = parseDecimalInput(stationRow.yText);
  const arrivalSeconds = parseDecimalInput(stationRow.arrivalText);
  if (xMeters === null || yMeters === null || arrivalSeconds === null) return null;
  return { stationName: stationRow.stationName.trim() || '?', xMeters, yMeters, arrivalSeconds };
}

type CentralPanelProps = Pick<InstrumentScreenProps<SeismicNetworkMeasurementValues>, 'saveMeasurement'>;

export function CentralPanel({ saveMeasurement }: CentralPanelProps) {
  const { t } = useTranslation(seismicNetworkInstrumentId);
  const themePalette = useThemePalette();
  const [stationRows, setStationRows] = useState<StationRow[]>(() =>
    Array.from({ length: initialRowCount }, (_, rowIndex) => createRow({ stationName: String.fromCharCode(65 + rowIndex) })),
  );
  const [pastedText, setPastedText] = useState('');
  const [locationMethod, setLocationMethod] = useState<LocationMethod>('free');
  const [knownSourceXText, setKnownSourceXText] = useState('');
  const [knownSourceYText, setKnownSourceYText] = useState('');
  const [knownSpeedText, setKnownSpeedText] = useState('');
  const [timingUncertaintyText, setTimingUncertaintyText] = useState(formatDecimal(defaultTimingUncertaintySeconds * 1000, 0));
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const stationReadings = useMemo(
    () => stationRows.map(readRow).filter((stationReading): stationReading is StationReading => stationReading !== null),
    [stationRows],
  );
  const knownSourceX = parseDecimalInput(knownSourceXText);
  const knownSourceY = parseDecimalInput(knownSourceYText);
  const knownSource = useMemo(
    () => (knownSourceX !== null && knownSourceY !== null ? { xMeters: knownSourceX, yMeters: knownSourceY } : null),
    [knownSourceX, knownSourceY],
  );
  const knownSpeedMetersPerSecond = parseDecimalInput(knownSpeedText);
  const timingUncertaintyMilliseconds = parseDecimalInput(timingUncertaintyText);
  const timingUncertaintySeconds =
    timingUncertaintyMilliseconds && timingUncertaintyMilliseconds > 0
      ? timingUncertaintyMilliseconds / 1000
      : defaultTimingUncertaintySeconds;

  const networkAnalysis = useMemo(
    () =>
      analyzeNetwork({
        stations: stationReadings,
        method: locationMethod,
        knownSource,
        knownSpeedMetersPerSecond,
        timingUncertaintySeconds,
      }),
    [stationReadings, locationMethod, knownSource, knownSpeedMetersPerSecond, timingUncertaintySeconds],
  );

  const earliestArrivalSeconds = stationReadings.length
    ? Math.min(...stationReadings.map((stationReading) => stationReading.arrivalSeconds))
    : 0;
  const mapStations: MapStation[] = stationReadings.map((stationReading) => ({
    stationName: stationReading.stationName,
    xMeters: stationReading.xMeters,
    yMeters: stationReading.yMeters,
    detailLabel: `+${formatDecimal((stationReading.arrivalSeconds - earliestArrivalSeconds) * 1000, 1)} ms`,
  }));

  function updateRow(rowId: number, changedFields: Partial<StationRow>) {
    setStationRows((previousRows) =>
      previousRows.map((stationRow) => (stationRow.rowId === rowId ? { ...stationRow, ...changedFields } : stationRow)),
    );
  }

  function handleImport() {
    const importedReadings = parseStationMessages(pastedText);
    if (importedReadings.length === 0) {
      setStatusMessage(t('central.nothingImported'));
      return;
    }
    setStationRows((previousRows) => {
      // Las filas vacías se descartan; una estación con el mismo nombre se sustituye.
      const importedNames = new Set(importedReadings.map((importedReading) => importedReading.stationName));
      const keptRows = previousRows.filter(
        (stationRow) => readRow(stationRow) !== null && !importedNames.has(stationRow.stationName.trim()),
      );
      return [...keptRows, ...importedReadings.map(rowFromReading)];
    });
    setPastedText('');
    setStatusMessage(t('central.imported', { count: importedReadings.length }));
  }

  function handleLoadDemo() {
    setStationRows(buildDemoReadings().map(rowFromReading));
    setLocationMethod('free');
    setStatusMessage(t('central.demoLoaded'));
  }

  async function handleSave() {
    if (networkAnalysis.status !== 'solved') return;
    setIsSaving(true);
    setStatusMessage(null);
    try {
      await saveMeasurement({
        values: {
          role: 'central',
          locationMethod: networkAnalysis.method,
          stationCount: stationReadings.length,
          sourceXMeters: networkAnalysis.source.xMeters,
          sourceYMeters: networkAnalysis.source.yMeters,
          apparentSpeedMetersPerSecond: networkAnalysis.apparentSpeedMetersPerSecond,
          originTimeSeconds: networkAnalysis.originTimeSeconds,
          rmsResidualSeconds: networkAnalysis.rmsResidualSeconds,
          stationNames: stationReadings.map((stationReading) => stationReading.stationName.replace(/,/g, ' ')).join(','),
          stationXs: stationReadings.map((stationReading) => stationReading.xMeters),
          stationYs: stationReadings.map((stationReading) => stationReading.yMeters),
          arrivalTimes: stationReadings.map((stationReading) => stationReading.arrivalSeconds),
          residualsSeconds: networkAnalysis.residualsSeconds,
        },
      });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  const inputStyle = [styles.input, { color: themePalette.textPrimary, borderColor: themePalette.border }];

  return (
    <>
      <BodyText tone="secondary">{t('central.help')}</BodyText>

      <Card>
        <BodyText style={styles.sectionLabel}>{t('central.stations')}</BodyText>
        <View style={styles.tableRow}>
          <BodyText tone="secondary" style={StyleSheet.flatten([styles.headerCell, styles.nameCell])}>
            {t('central.nameColumn')}
          </BodyText>
          <BodyText tone="secondary" style={StyleSheet.flatten([styles.headerCell, styles.numberCell])}>
            x (m)
          </BodyText>
          <BodyText tone="secondary" style={StyleSheet.flatten([styles.headerCell, styles.numberCell])}>
            y (m)
          </BodyText>
          <BodyText tone="secondary" style={StyleSheet.flatten([styles.headerCell, styles.arrivalCell])}>
            {t('central.arrivalColumn')}
          </BodyText>
          <View style={styles.removeCell} />
        </View>
        {stationRows.map((stationRow) => {
          const isRowIncomplete = readRow(stationRow) === null;
          return (
            <View key={stationRow.rowId} style={styles.tableRow}>
              <TextInput
                value={stationRow.stationName}
                onChangeText={(changedText) => updateRow(stationRow.rowId, { stationName: changedText })}
                style={[inputStyle, styles.nameCell]}
                maxLength={16}
              />
              <TextInput
                value={stationRow.xText}
                onChangeText={(changedText) => updateRow(stationRow.rowId, { xText: changedText })}
                keyboardType="numbers-and-punctuation"
                style={[inputStyle, styles.numberCell]}
              />
              <TextInput
                value={stationRow.yText}
                onChangeText={(changedText) => updateRow(stationRow.rowId, { yText: changedText })}
                keyboardType="numbers-and-punctuation"
                style={[inputStyle, styles.numberCell]}
              />
              <TextInput
                value={stationRow.arrivalText}
                onChangeText={(changedText) => updateRow(stationRow.rowId, { arrivalText: changedText })}
                keyboardType="numbers-and-punctuation"
                placeholder="s"
                placeholderTextColor={themePalette.textSecondary}
                style={[inputStyle, styles.arrivalCell, isRowIncomplete ? { borderColor: themePalette.textSecondary, borderStyle: 'dashed' } : null]}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('central.removeStation', { name: stationRow.stationName })}
                onPress={() => setStationRows((previousRows) => previousRows.filter((candidateRow) => candidateRow.rowId !== stationRow.rowId))}
                style={styles.removeCell}>
                <BodyText tone="danger">✕</BodyText>
              </Pressable>
            </View>
          );
        })}
        <AppButton
          label={t('central.addStation')}
          onPress={() =>
            setStationRows((previousRows) => [...previousRows, createRow({ stationName: String.fromCharCode(65 + (previousRows.length % 26)) })])
          }
          variant="secondary"
        />
      </Card>

      <Card>
        <BodyText style={styles.sectionLabel}>{t('central.pasteTitle')}</BodyText>
        <BodyText tone="secondary">{t('central.pasteHelp')}</BodyText>
        <TextInput
          value={pastedText}
          onChangeText={setPastedText}
          multiline
          placeholder="#sismo|A|0.000|0.000|12.34560"
          placeholderTextColor={themePalette.textSecondary}
          style={[inputStyle, styles.pasteInput]}
        />
        <View style={styles.buttonRow}>
          <View style={styles.buttonCell}>
            <AppButton label={t('central.import')} onPress={handleImport} isDisabled={!pastedText.trim()} variant="secondary" />
          </View>
          <View style={styles.buttonCell}>
            <AppButton label={t('central.loadDemo')} onPress={handleLoadDemo} variant="secondary" />
          </View>
        </View>
      </Card>

      <BodyText style={styles.sectionLabel}>{t('central.methodTitle')}</BodyText>
      <View style={styles.segmentedRow}>
        {locationMethods.map((method) => {
          const isSelectedMethod = method === locationMethod;
          return (
            <Pressable
              key={method}
              accessibilityRole="radio"
              accessibilityState={{ selected: isSelectedMethod }}
              onPress={() => setLocationMethod(method)}
              style={[styles.segment, { borderColor: isSelectedMethod ? themePalette.accent : themePalette.border }]}>
              <BodyText tone={isSelectedMethod ? 'accent' : 'primary'} style={styles.segmentLabel}>
                {t(`central.methods.${method}`)}
              </BodyText>
            </Pressable>
          );
        })}
      </View>
      <BodyText tone="secondary">{t(`central.methodHelp.${locationMethod}`)}</BodyText>
      {locationMethod === 'known-source' ? (
        <View style={styles.inputRow}>
          <View style={styles.inputCell}>
            <BodyText tone="secondary" style={styles.inputLabel}>
              {t('central.sourceX')}
            </BodyText>
            <TextInput value={knownSourceXText} onChangeText={setKnownSourceXText} keyboardType="numbers-and-punctuation" style={inputStyle} />
          </View>
          <View style={styles.inputCell}>
            <BodyText tone="secondary" style={styles.inputLabel}>
              {t('central.sourceY')}
            </BodyText>
            <TextInput value={knownSourceYText} onChangeText={setKnownSourceYText} keyboardType="numbers-and-punctuation" style={inputStyle} />
          </View>
        </View>
      ) : null}
      {locationMethod === 'known-speed' ? (
        <View style={styles.inputCell}>
          <BodyText tone="secondary" style={styles.inputLabel}>
            {t('central.knownSpeed')}
          </BodyText>
          <TextInput value={knownSpeedText} onChangeText={setKnownSpeedText} keyboardType="numbers-and-punctuation" style={inputStyle} />
        </View>
      ) : null}
      <View style={styles.inputCell}>
        <BodyText tone="secondary" style={styles.inputLabel}>
          {t('central.timingUncertainty')}
        </BodyText>
        <TextInput
          value={timingUncertaintyText}
          onChangeText={setTimingUncertaintyText}
          keyboardType="numbers-and-punctuation"
          style={inputStyle}
        />
      </View>

      {networkAnalysis.mapBounds ? (
        <NetworkMap
          stations={mapStations}
          bounds={networkAnalysis.mapBounds}
          estimatedSource={networkAnalysis.status === 'solved' && networkAnalysis.method !== 'known-source' ? networkAnalysis.source : null}
          knownSource={locationMethod === 'known-source' ? knownSource : null}
          compatibleRegion={networkAnalysis.status === 'solved' ? networkAnalysis.compatibleRegion : []}
          accessibilityLabel={t('central.mapLabel')}
        />
      ) : null}
      <View style={styles.legendRow}>
        <BodyText tone="secondary" style={styles.legendText}>
          ◆ {t('central.legendStation')}
        </BodyText>
        <BodyText style={{ ...styles.legendText, color: networkMapColors.estimatedSource }}>✕ {t('central.legendSource')}</BodyText>
        <BodyText style={{ ...styles.legendText, color: networkMapColors.region }}>● {t('central.legendRegion')}</BodyText>
        {locationMethod === 'known-source' ? (
          <BodyText style={{ ...styles.legendText, color: networkMapColors.knownSource }}>○ {t('central.legendKnownSource')}</BodyText>
        ) : null}
      </View>

      <Card>
        {networkAnalysis.status === 'not-enough-stations' ? (
          <BodyText tone="secondary">{t('central.notEnough', { count: networkAnalysis.requiredStationCount })}</BodyText>
        ) : null}
        {networkAnalysis.status === 'missing-parameter' ? (
          <BodyText tone="secondary">{t(`central.missing.${locationMethod}`)}</BodyText>
        ) : null}
        {networkAnalysis.status === 'no-solution' ? <BodyText tone="danger">{t('central.noSolution')}</BodyText> : null}
        {networkAnalysis.status === 'solved' ? (
          <>
            <View style={styles.readingsGrid}>
              {networkAnalysis.method !== 'known-source' ? (
                <Reading
                  label={t('central.epicenter')}
                  value={`(${formatDecimal(networkAnalysis.source.xMeters, 2)}; ${formatDecimal(networkAnalysis.source.yMeters, 2)}) m`}
                />
              ) : null}
              <Reading
                label={t('central.speed')}
                value={`${formatDecimal(networkAnalysis.apparentSpeedMetersPerSecond, 0)} m/s`}
              />
              <Reading label={t('central.originTime')} value={`${formatDecimal(networkAnalysis.originTimeSeconds, 4)} s`} />
              <Reading label={t('central.rmsResidual')} value={`${formatDecimal(networkAnalysis.rmsResidualSeconds * 1000, 1)} ms`} />
            </View>
            <BodyText tone="secondary">
              {t('central.residualsList', {
                list: stationReadings
                  .map(
                    (stationReading, stationIndex) =>
                      `${stationReading.stationName} ${networkAnalysis.residualsSeconds[stationIndex]! >= 0 ? '+' : ''}${formatDecimal(
                        networkAnalysis.residualsSeconds[stationIndex]! * 1000,
                        1,
                      )}`,
                  )
                  .join(' · '),
              })}
            </BodyText>
            {networkAnalysis.isAtSearchBoundary ? <BodyText tone="danger">{t('central.warnings.boundary')}</BodyText> : null}
            {networkAnalysis.hasNoRedundancy ? <BodyText tone="danger">{t('central.warnings.noRedundancy')}</BodyText> : null}
            {networkAnalysis.hasLargeResidual ? <BodyText tone="danger">{t('central.warnings.largeResidual')}</BodyText> : null}
            <AppButton label={t('core:common.save')} onPress={() => void handleSave()} isBusy={isSaving} />
          </>
        ) : null}
      </Card>
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}
    </>
  );
}

function Reading({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.readingCell}>
      <BodyText tone="secondary" style={styles.inputLabel}>
        {label}
      </BodyText>
      <BodyText style={styles.readingValue}>{value}</BodyText>
    </View>
  );
}

const styles = StyleSheet.create({
  sectionLabel: { fontWeight: '600' },
  tableRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  headerCell: { fontSize: 12 },
  nameCell: { flex: 1.3 },
  numberCell: { flex: 1 },
  arrivalCell: { flex: 1.6 },
  removeCell: { width: 28, alignItems: 'center', justifyContent: 'center', minHeight: 40 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, fontSize: 15 },
  pasteInput: { minHeight: 70, textAlignVertical: 'top' },
  inputRow: { flexDirection: 'row', gap: 8 },
  inputCell: { flex: 1, gap: 2 },
  inputLabel: { fontSize: 13 },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonCell: { flex: 1 },
  segmentedRow: { flexDirection: 'row', gap: 6 },
  segment: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 8, paddingHorizontal: 4, borderRadius: 10, borderWidth: 1.5 },
  segmentLabel: { fontSize: 13, textAlign: 'center' },
  legendRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  legendText: { fontSize: 13 },
  readingsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  readingCell: { flexBasis: '45%', flexGrow: 1, gap: 2 },
  readingValue: { fontSize: 20, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
