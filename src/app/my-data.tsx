import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  type ExportFormat,
  shareMeasurements,
  shareMeasurementsOfSeveralInstruments,
} from '@/core/export/shareMeasurements';
import { enabledInstruments, findInstrument } from '@/core/instruments/registryAccess';
import { collectMeasurementImages, type MeasurementImage } from '@/core/measurements/imageAttachments';
import {
  buildDayListRows,
  buildMeasurementFilter,
  type DateRangeFilter,
  dateFromLocalDayKey,
  type DayListRow,
  dateRangeFilters,
  toggleSelection,
} from '@/core/measurements/measurementFilter';
import { appendPage, shouldPrefetchMore } from '@/core/measurements/pagination';
import { sqliteMeasurementRepository } from '@/core/measurements/sqliteMeasurementRepository';
import type { Attachment, Measurement } from '@/core/measurements/types';
import { AppButton, BodyText, Card, SectionTitle } from '@/ui/components';
import { ImageViewer, type ImageViewerItem } from '@/ui/ImageViewer';
import { AttachmentThumbnail, MeasurementAttachments } from '@/ui/MeasurementAttachments';
import { instrumentDisplayName, summarizeMeasurementValues } from '@/ui/measurementText';
import { useThemePalette } from '@/ui/theme';

type ViewMode = 'list' | 'gallery';

const measurementPageSize = 25;
const imagePageSize = 60;
const screenPadding = 16;
const galleryGap = 4;

/** Todas las mediciones de todos los instrumentos, con filtros, vista de lista o de galería y exportación. */
export default function MyDataScreen() {
  const { t, i18n } = useTranslation();
  const themePalette = useThemePalette();
  const { bottom: bottomInset } = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();

  const [selectedInstrumentIds, setSelectedInstrumentIds] = useState<string[]>([]);
  const [dateRange, setDateRange] = useState<DateRangeFilter>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [measurementCountByInstrument, setMeasurementCountByInstrument] = useState<Map<string, number>>(new Map());
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [hasMoreMeasurements, setHasMoreMeasurements] = useState(false);
  const [filteredMeasurementCount, setFilteredMeasurementCount] = useState(0);
  const [galleryImages, setGalleryImages] = useState<MeasurementImage[]>([]);
  const [hasMoreImages, setHasMoreImages] = useState(false);
  const [isLoadingFirstPage, setIsLoadingFirstPage] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [exportingFormat, setExportingFormat] = useState<ExportFormat | null>(null);
  const [viewerSource, setViewerSource] = useState<ViewMode>('list');
  const [openedImageIndex, setOpenedImageIndex] = useState<number | null>(null);

  // Cada carga lleva un número: si cambian los filtros a mitad, la respuesta antigua se descarta.
  const loadGenerationRef = useRef(0);
  const isLoadingMoreRef = useRef(false);

  const measurementFilter = useMemo(
    () => buildMeasurementFilter(selectedInstrumentIds, dateRange),
    [selectedInstrumentIds, dateRange],
  );

  const loadFirstPage = useCallback(async () => {
    const loadGeneration = ++loadGenerationRef.current;
    setIsLoadingFirstPage(true);
    try {
      const [countByInstrument, measurementCount, firstMeasurements, firstImages] = await Promise.all([
        sqliteMeasurementRepository.countPerInstrument(),
        sqliteMeasurementRepository.countFiltered(measurementFilter),
        sqliteMeasurementRepository.listFiltered(measurementFilter, { limit: measurementPageSize, offset: 0 }),
        sqliteMeasurementRepository.listImages(measurementFilter, { limit: imagePageSize, offset: 0 }),
      ]);
      if (loadGeneration !== loadGenerationRef.current) return;
      setMeasurementCountByInstrument(countByInstrument);
      setFilteredMeasurementCount(measurementCount);
      setMeasurements(firstMeasurements);
      setHasMoreMeasurements(firstMeasurements.length >= measurementPageSize);
      setGalleryImages(firstImages);
      setHasMoreImages(firstImages.length >= imagePageSize);
      setErrorMessage(null);
    } catch (loadError) {
      if (loadGeneration === loadGenerationRef.current) setErrorMessage(String(loadError));
    } finally {
      if (loadGeneration === loadGenerationRef.current) setIsLoadingFirstPage(false);
    }
  }, [measurementFilter]);

  useFocusEffect(
    useCallback(() => {
      void loadFirstPage();
    }, [loadFirstPage]),
  );

  const loadMoreMeasurements = useCallback(async () => {
    if (!hasMoreMeasurements || isLoadingMoreRef.current || isLoadingFirstPage) return;
    isLoadingMoreRef.current = true;
    const loadGeneration = loadGenerationRef.current;
    try {
      const nextMeasurements = await sqliteMeasurementRepository.listFiltered(measurementFilter, {
        limit: measurementPageSize,
        offset: measurements.length,
      });
      if (loadGeneration !== loadGenerationRef.current) return;
      const pagedMeasurements = appendPage(measurements, nextMeasurements, measurementPageSize, (measurement) => measurement.id);
      setMeasurements(pagedMeasurements.items);
      setHasMoreMeasurements(pagedMeasurements.hasMore);
    } catch (loadError) {
      setErrorMessage(String(loadError));
    } finally {
      isLoadingMoreRef.current = false;
    }
  }, [hasMoreMeasurements, isLoadingFirstPage, measurementFilter, measurements]);

  const loadMoreImages = useCallback(async () => {
    if (!hasMoreImages || isLoadingMoreRef.current || isLoadingFirstPage) return;
    isLoadingMoreRef.current = true;
    const loadGeneration = loadGenerationRef.current;
    try {
      const nextImages = await sqliteMeasurementRepository.listImages(measurementFilter, {
        limit: imagePageSize,
        offset: galleryImages.length,
      });
      if (loadGeneration !== loadGenerationRef.current) return;
      const pagedImages = appendPage(galleryImages, nextImages, imagePageSize, (galleryImage) => galleryImage.attachment.id);
      setGalleryImages(pagedImages.items);
      setHasMoreImages(pagedImages.hasMore);
    } catch (loadError) {
      setErrorMessage(String(loadError));
    } finally {
      isLoadingMoreRef.current = false;
    }
  }, [galleryImages, hasMoreImages, isLoadingFirstPage, measurementFilter]);

  const formatDateTime = useCallback(
    (timestamp: number) => new Date(timestamp).toLocaleString(i18n.language),
    [i18n.language],
  );

  const toViewerItems = useCallback(
    (measurementImages: readonly MeasurementImage[]): ImageViewerItem[] =>
      measurementImages.map((measurementImage) => ({
        attachment: measurementImage.attachment,
        caption: `${instrumentDisplayName(t, findInstrument(measurementImage.instrumentId), measurementImage.instrumentId)} · ${formatDateTime(measurementImage.timestamp)}`,
      })),
    [t, formatDateTime],
  );

  const listViewerImages = useMemo(() => toViewerItems(collectMeasurementImages(measurements)), [measurements, toViewerItems]);
  const galleryViewerImages = useMemo(() => toViewerItems(galleryImages), [galleryImages, toViewerItems]);
  const viewerImages = viewerSource === 'gallery' ? galleryViewerImages : listViewerImages;

  const handleViewerIndexChange = useCallback(
    (currentIndex: number) => {
      if (viewerSource === 'gallery' && shouldPrefetchMore(currentIndex, galleryImages.length, hasMoreImages)) {
        void loadMoreImages();
      } else if (
        viewerSource === 'list' &&
        shouldPrefetchMore(currentIndex, listViewerImages.length, hasMoreMeasurements)
      ) {
        void loadMoreMeasurements();
      }
    },
    [viewerSource, galleryImages.length, hasMoreImages, loadMoreImages, listViewerImages.length, hasMoreMeasurements, loadMoreMeasurements],
  );

  function openListImage(attachment: Attachment) {
    const imageIndex = listViewerImages.findIndex((viewerImage) => viewerImage.attachment.id === attachment.id);
    if (imageIndex < 0) return;
    setViewerSource('list');
    setOpenedImageIndex(imageIndex);
  }

  function openGalleryImage(imageIndex: number) {
    setViewerSource('gallery');
    setOpenedImageIndex(imageIndex);
  }

  const instrumentsWithMeasurements = useMemo(() => {
    const knownInstruments = enabledInstruments.filter((instrument) => measurementCountByInstrument.has(instrument.id));
    return knownInstruments.sort((firstInstrument, secondInstrument) =>
      instrumentDisplayName(t, firstInstrument, firstInstrument.id).localeCompare(
        instrumentDisplayName(t, secondInstrument, secondInstrument.id),
        i18n.language,
      ),
    );
  }, [measurementCountByInstrument, t, i18n.language]);

  const totalMeasurementCount = [...measurementCountByInstrument.values()].reduce(
    (countSum, instrumentCount) => countSum + instrumentCount,
    0,
  );
  const singleSelectedInstrument =
    selectedInstrumentIds.length === 1 ? findInstrument(selectedInstrumentIds[0]!) : undefined;

  async function handleExport(exportFormat: ExportFormat) {
    setExportingFormat(exportFormat);
    try {
      const allFilteredMeasurements = await sqliteMeasurementRepository.listFiltered(measurementFilter);
      if (singleSelectedInstrument) {
        await shareMeasurements(singleSelectedInstrument, allFilteredMeasurements, exportFormat, t('history.exportDialogTitle'));
      } else {
        await shareMeasurementsOfSeveralInstruments(allFilteredMeasurements, findInstrument, t('history.exportDialogTitle'));
      }
    } catch (exportError) {
      Alert.alert(t('common.error', { message: String(exportError) }));
    } finally {
      setExportingFormat(null);
    }
  }

  const galleryColumnCount = windowWidth >= 600 ? 5 : windowWidth >= 400 ? 4 : 3;
  const galleryThumbnailSize = Math.floor(
    (windowWidth - screenPadding * 2 - galleryGap * (galleryColumnCount - 1)) / galleryColumnCount,
  );

  const listRows = useMemo(() => buildDayListRows(measurements), [measurements]);

  const filtersHeader = (
    <View style={styles.headerColumn}>
      <SectionTitle>{t('myData.instrumentFilter')}</SectionTitle>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
        <FilterChip
          label={t('myData.allInstruments')}
          isSelected={selectedInstrumentIds.length === 0}
          onPress={() => setSelectedInstrumentIds([])}
        />
        {instrumentsWithMeasurements.map((instrument) => (
          <FilterChip
            key={instrument.id}
            label={`${instrument.icon.glyph} ${instrumentDisplayName(t, instrument, instrument.id)} (${measurementCountByInstrument.get(instrument.id) ?? 0})`}
            isSelected={selectedInstrumentIds.includes(instrument.id)}
            onPress={() => setSelectedInstrumentIds((previousIds) => toggleSelection(previousIds, instrument.id))}
          />
        ))}
      </ScrollView>

      <SectionTitle>{t('myData.dateFilter')}</SectionTitle>
      <View style={styles.chipWrap}>
        {dateRangeFilters.map((dateRangeOption) => (
          <FilterChip
            key={dateRangeOption}
            label={t(`myData.dateRange.${dateRangeOption}`)}
            isSelected={dateRange === dateRangeOption}
            onPress={() => setDateRange(dateRangeOption)}
          />
        ))}
      </View>

      <View style={[styles.segmentedControl, { borderColor: themePalette.accent }]}>
        {(['list', 'gallery'] as const).map((viewModeOption) => {
          const isSelectedMode = viewMode === viewModeOption;
          return (
            <Pressable
              key={viewModeOption}
              accessibilityRole="tab"
              accessibilityState={{ selected: isSelectedMode }}
              onPress={() => setViewMode(viewModeOption)}
              style={[styles.segment, isSelectedMode ? { backgroundColor: themePalette.accent } : null]}>
              <BodyText style={{ ...styles.segmentLabel, color: isSelectedMode ? themePalette.onAccent : themePalette.accent }}>
                {t(viewModeOption === 'list' ? 'myData.viewList' : 'myData.viewGallery')}
              </BodyText>
            </Pressable>
          );
        })}
      </View>

      <BodyText tone="secondary">
        {t('myData.measurementCount', { count: filteredMeasurementCount })}
      </BodyText>

      {filteredMeasurementCount > 0 ? (
        <Card>
          <BodyText style={styles.exportTitle}>{t('myData.export')}</BodyText>
          <BodyText tone="secondary">{t('myData.exportHint')}</BodyText>
          {singleSelectedInstrument ? (
            <View style={styles.exportRow}>
              {(['csv', 'json'] as const).map((exportFormat) => (
                <View key={exportFormat} style={styles.exportButton}>
                  <AppButton
                    label={t(exportFormat === 'csv' ? 'history.exportCsv' : 'history.exportJson')}
                    variant="secondary"
                    onPress={() => void handleExport(exportFormat)}
                    isDisabled={exportingFormat !== null}
                    isBusy={exportingFormat === exportFormat}
                  />
                </View>
              ))}
            </View>
          ) : (
            <>
              <AppButton
                label={t('myData.exportAllJson')}
                variant="secondary"
                onPress={() => void handleExport('json')}
                isDisabled={exportingFormat !== null}
                isBusy={exportingFormat === 'json'}
              />
              <BodyText tone="secondary">{t('myData.exportCsvHint')}</BodyText>
            </>
          )}
        </Card>
      ) : null}

      {errorMessage ? (
        <Card>
          <BodyText tone="danger">{t('common.error', { message: errorMessage })}</BodyText>
          <AppButton label={t('common.retry')} onPress={() => void loadFirstPage()} variant="secondary" />
        </Card>
      ) : null}
    </View>
  );

  const emptyMessage = isLoadingFirstPage ? null : totalMeasurementCount === 0
    ? t('myData.empty')
    : viewMode === 'gallery'
      ? t('myData.emptyGallery')
      : t('myData.emptyFiltered');
  const emptyComponent = isLoadingFirstPage ? (
    <ActivityIndicator color={themePalette.accent} style={styles.loadingIndicator} />
  ) : (
    <Card>
      <BodyText tone="secondary">{emptyMessage}</BodyText>
    </Card>
  );
  const isLoadingMore = viewMode === 'list' ? hasMoreMeasurements : hasMoreImages;
  const footerComponent = isLoadingMore ? (
    <ActivityIndicator color={themePalette.accent} style={styles.loadingIndicator} />
  ) : null;
  const listContentStyle = [styles.listContent, { paddingBottom: screenPadding + bottomInset }];
  const galleryContentStyle = [...listContentStyle, styles.galleryContent];

  return (
    <>
      {viewMode === 'list' ? (
        <FlatList
          key="list"
          data={listRows}
          keyExtractor={(listRow) => (listRow.rowKind === 'day' ? `day-${listRow.dayKey}` : listRow.item.id)}
          ListHeaderComponent={filtersHeader}
          ListEmptyComponent={emptyComponent}
          ListFooterComponent={footerComponent}
          contentContainerStyle={listContentStyle}
          onEndReached={() => void loadMoreMeasurements()}
          onEndReachedThreshold={0.6}
          renderItem={({ item: listRow }) => (
            <MeasurementListRow
              listRow={listRow}
              locale={i18n.language}
              formatDateTime={formatDateTime}
              onOpenImage={openListImage}
            />
          )}
        />
      ) : (
        <FlatList
          key={`gallery-${galleryColumnCount}`}
          data={galleryImages}
          numColumns={galleryColumnCount}
          keyExtractor={(galleryImage) => galleryImage.attachment.id}
          ListHeaderComponent={filtersHeader}
          ListEmptyComponent={emptyComponent}
          ListFooterComponent={footerComponent}
          contentContainerStyle={galleryContentStyle}
          columnWrapperStyle={styles.galleryRow}
          onEndReached={() => void loadMoreImages()}
          onEndReachedThreshold={0.6}
          renderItem={({ item: galleryImage, index: imageIndex }) => (
            <AttachmentThumbnail
              attachment={galleryImage.attachment}
              size={galleryThumbnailSize}
              accessibilityLabel={galleryViewerImages[imageIndex]?.caption ?? galleryImage.attachment.fileName}
              onPress={() => openGalleryImage(imageIndex)}
            />
          )}
        />
      )}
      <ImageViewer
        images={viewerImages}
        openedIndex={openedImageIndex}
        onClose={() => setOpenedImageIndex(null)}
        onIndexChange={handleViewerIndexChange}
      />
    </>
  );
}

function MeasurementListRow({
  listRow,
  locale,
  formatDateTime,
  onOpenImage,
}: {
  listRow: DayListRow<Measurement>;
  locale: string;
  formatDateTime(timestamp: number): string;
  onOpenImage(attachment: Attachment): void;
}) {
  const { t } = useTranslation();
  const themePalette = useThemePalette();
  if (listRow.rowKind === 'day') {
    const dayText = dateFromLocalDayKey(listRow.dayKey).toLocaleDateString(locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    return <SectionTitle>{dayText}</SectionTitle>;
  }

  const measurement = listRow.item;
  const instrument = findInstrument(measurement.instrumentId);
  const instrumentName = instrumentDisplayName(t, instrument, measurement.instrumentId);
  const valuesSummary = instrument ? summarizeMeasurementValues(t, locale, measurement, instrument) : '';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('myData.openHistory', { instrument: instrumentName })}
      disabled={!instrument}
      onPress={() => router.push({ pathname: '/instrument/[id]/history', params: { id: measurement.instrumentId } })}
      style={({ pressed }) => [
        styles.measurementCard,
        { backgroundColor: themePalette.surface, borderColor: themePalette.border, opacity: pressed ? 0.8 : 1 },
      ]}>
      <View style={styles.measurementHeader}>
        {instrument ? (
          <View style={[styles.iconBadge, { backgroundColor: instrument.icon.accentColor }]}>
            <BodyText style={styles.iconGlyph}>{instrument.icon.glyph}</BodyText>
          </View>
        ) : null}
        <View style={styles.measurementTitleColumn}>
          <BodyText style={styles.instrumentName} numberOfLines={1}>
            {instrumentName}
          </BodyText>
          <BodyText tone="secondary">{formatDateTime(measurement.timestamp)}</BodyText>
        </View>
        <BodyText tone="accent">›</BodyText>
      </View>
      {valuesSummary ? <BodyText numberOfLines={2}>{valuesSummary}</BodyText> : null}
      {measurement.note ? (
        <BodyText tone="secondary" numberOfLines={2}>
          {measurement.note}
        </BodyText>
      ) : null}
      <MeasurementAttachments attachments={measurement.attachments} onOpenImage={onOpenImage} />
    </Pressable>
  );
}

function FilterChip({ label, isSelected, onPress }: { label: string; isSelected: boolean; onPress(): void }) {
  const themePalette = useThemePalette();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: isSelected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          borderColor: isSelected ? themePalette.accent : themePalette.border,
          backgroundColor: isSelected ? themePalette.accent : themePalette.surface,
          opacity: pressed ? 0.75 : 1,
        },
      ]}>
      <BodyText style={{ color: isSelected ? themePalette.onAccent : themePalette.textPrimary }}>{label}</BodyText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  listContent: { padding: screenPadding, gap: 12, flexGrow: 1 },
  headerColumn: { gap: 10, marginBottom: 8 },
  chipRow: { gap: 8, paddingRight: 8 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 18, borderWidth: 1 },
  segmentedControl: { flexDirection: 'row', borderWidth: 1.5, borderRadius: 10, overflow: 'hidden', marginTop: 4 },
  segment: { flex: 1, minHeight: 40, alignItems: 'center', justifyContent: 'center' },
  segmentLabel: { fontWeight: '600' },
  exportTitle: { fontWeight: '600' },
  exportRow: { flexDirection: 'row', gap: 8 },
  exportButton: { flex: 1 },
  loadingIndicator: { marginVertical: 16 },
  galleryContent: { gap: galleryGap },
  galleryRow: { gap: galleryGap },
  measurementCard: { padding: 16, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, gap: 8 },
  measurementHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  measurementTitleColumn: { flex: 1 },
  instrumentName: { fontWeight: '600' },
  iconBadge: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  iconGlyph: { fontSize: 18 },
});
