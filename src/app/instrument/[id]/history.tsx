import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, StyleSheet, View } from 'react-native';

import { type ExportFormat, shareAttachment, shareMeasurements } from '@/core/export/shareMeasurements';
import { findInstrument } from '@/core/instruments/registryAccess';
import type { AnyInstrumentDefinition } from '@/core/instruments/types';
import { deleteMeasurement } from '@/core/measurements/measurementService';
import { sqliteMeasurementRepository } from '@/core/measurements/sqliteMeasurementRepository';
import { type Measurement, readMeasurementField } from '@/core/measurements/types';
import { AppButton, BodyText, Card, LoadingState, ScreenContainer } from '@/ui/components';

const pageSize = 30;

export default function MeasurementHistoryScreen() {
  const { id: instrumentId } = useLocalSearchParams<{ id: string }>();
  const { t, i18n } = useTranslation();
  const instrument = findInstrument(instrumentId);
  const [measurements, setMeasurements] = useState<Measurement[] | null>(null);
  const [totalMeasurementCount, setTotalMeasurementCount] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [exportingFormat, setExportingFormat] = useState<ExportFormat | null>(null);

  const loadFirstPage = useCallback(async () => {
    try {
      const [firstPage, measurementCount] = await Promise.all([
        sqliteMeasurementRepository.listByInstrument(instrumentId, { limit: pageSize, offset: 0 }),
        sqliteMeasurementRepository.countByInstrument(instrumentId),
      ]);
      setMeasurements(firstPage);
      setTotalMeasurementCount(measurementCount);
      setErrorMessage(null);
    } catch (loadError) {
      setErrorMessage(String(loadError));
    }
  }, [instrumentId]);

  useFocusEffect(
    useCallback(() => {
      void loadFirstPage();
    }, [loadFirstPage]),
  );

  if (!instrument) {
    return (
      <ScreenContainer>
        <BodyText>{t('instrument.notFound')}</BodyText>
      </ScreenContainer>
    );
  }

  const screenTitle = t('history.title', { instrument: t(instrument.nameKey, { ns: instrument.id }) });
  const screenOptions = <Stack.Screen options={{ title: screenTitle }} />;

  if (errorMessage) {
    return (
      <ScreenContainer>
        {screenOptions}
        <BodyText tone="danger">{t('common.error', { message: errorMessage })}</BodyText>
        <AppButton label={t('common.retry')} onPress={() => void loadFirstPage()} />
      </ScreenContainer>
    );
  }
  if (!measurements) {
    return (
      <>
        {screenOptions}
        <LoadingState label={t('common.loading')} />
      </>
    );
  }

  async function handleLoadMore() {
    const nextPage = await sqliteMeasurementRepository.listByInstrument(instrumentId, {
      limit: pageSize,
      offset: measurements?.length ?? 0,
    });
    setMeasurements((previousMeasurements) => [...(previousMeasurements ?? []), ...nextPage]);
  }

  async function handleExport(exportFormat: ExportFormat) {
    if (!instrument) return;
    setExportingFormat(exportFormat);
    try {
      const allMeasurements = await sqliteMeasurementRepository.listByInstrument(instrument.id);
      await shareMeasurements(instrument, allMeasurements, exportFormat, t('history.exportDialogTitle'));
    } catch (exportError) {
      Alert.alert(t('common.error', { message: String(exportError) }));
    } finally {
      setExportingFormat(null);
    }
  }

  function confirmDelete(measurementId: string) {
    Alert.alert(t('history.deleteTitle'), t('history.deleteMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          await deleteMeasurement(measurementId);
          await loadFirstPage();
        },
      },
    ]);
  }

  const hasMeasurements = measurements.length > 0;
  return (
    <ScreenContainer>
      {screenOptions}
      <BodyText tone="secondary">{t('history.count', { count: totalMeasurementCount })}</BodyText>
      <View style={styles.exportRow}>
        {(['csv', 'json'] as const).map((exportFormat) => (
          <View key={exportFormat} style={styles.exportButton}>
            <AppButton
              label={t(exportFormat === 'csv' ? 'history.exportCsv' : 'history.exportJson')}
              onPress={() => void handleExport(exportFormat)}
              variant="secondary"
              isDisabled={!hasMeasurements || exportingFormat !== null}
              isBusy={exportingFormat === exportFormat}
            />
          </View>
        ))}
      </View>

      {!hasMeasurements ? (
        <Card>
          <BodyText tone="secondary">{t('history.empty')}</BodyText>
        </Card>
      ) : null}

      {measurements.map((measurement) => (
        <MeasurementRow
          key={measurement.id}
          measurement={measurement}
          instrument={instrument}
          locale={i18n.language}
          onDelete={() => confirmDelete(measurement.id)}
        />
      ))}

      {measurements.length < totalMeasurementCount ? (
        <AppButton label={t('history.loadMore')} onPress={() => void handleLoadMore()} variant="secondary" />
      ) : null}
    </ScreenContainer>
  );
}

function MeasurementRow({
  measurement,
  instrument,
  locale,
  onDelete,
}: {
  measurement: Measurement;
  instrument: AnyInstrumentDefinition;
  locale: string;
  onDelete(): void;
}) {
  const { t } = useTranslation();
  const numberFormatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });

  function formatFieldValue(fieldValue: unknown, unit: string | undefined): string {
    if (Array.isArray(fieldValue)) return t('history.arrayValues', { count: fieldValue.length });
    const formattedValue = typeof fieldValue === 'number' ? numberFormatter.format(fieldValue) : String(fieldValue ?? '—');
    return unit ? `${formattedValue} ${unit}` : formattedValue;
  }

  const detailTags = [
    measurement.location ? t('history.withLocation') : null,
    measurement.attachments.length > 0 ? t('history.attachments', { count: measurement.attachments.length }) : null,
  ].filter(Boolean);

  return (
    <Card>
      <View style={styles.rowHeader}>
        <BodyText style={styles.rowDate}>{new Date(measurement.timestamp).toLocaleString(locale)}</BodyText>
        <AppButton label={t('common.delete')} onPress={onDelete} variant="danger" />
      </View>
      {instrument.dataSchema.fields.map((field) => {
        const fieldValue = readMeasurementField(measurement.values, field.key);
        if (field.optional && (fieldValue === undefined || fieldValue === null)) return null;
        return (
          <View key={field.key} style={styles.fieldRow}>
            {field.type === 'color' && typeof fieldValue === 'string' ? (
              <View style={[styles.colorSwatch, { backgroundColor: fieldValue }]} />
            ) : null}
            <BodyText style={styles.fieldText}>
              <BodyText tone="secondary">{`${t(field.labelKey, { ns: instrument.id })}: `}</BodyText>
              {formatFieldValue(fieldValue, field.unit)}
            </BodyText>
          </View>
        );
      })}
      {measurement.note ? <BodyText tone="secondary">{measurement.note}</BodyText> : null}
      {detailTags.length > 0 ? <BodyText tone="secondary">{detailTags.join(' · ')}</BodyText> : null}
      {measurement.attachments.map((attachment) => (
        <AppButton
          key={attachment.id}
          label={t('history.shareAttachment', { fileName: attachment.fileName })}
          variant="secondary"
          onPress={() =>
            shareAttachment(attachment, t('history.exportDialogTitle')).catch((shareError: unknown) =>
              Alert.alert(t('common.error', { message: String(shareError) })),
            )
          }
        />
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  exportRow: { flexDirection: 'row', gap: 8 },
  exportButton: { flex: 1 },
  rowHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  rowDate: { flex: 1, fontWeight: '600' },
  fieldRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fieldText: { flex: 1 },
  colorSwatch: { width: 18, height: 18, borderRadius: 4 },
});
