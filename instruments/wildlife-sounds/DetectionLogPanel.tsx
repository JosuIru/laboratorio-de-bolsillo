import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { AppButton, BodyText, Card } from '@/ui/components';

import { similarityText } from './customSounds';
import type { DetectionRecord } from './detectionLog';
import type { DetectionStatistics } from './detectionStore';
import { clockTimeText } from './SessionPanel';
import type { DetectionExportKind } from './shareDetectionFiles';

const wildlifeSoundsNamespace = 'wildlife-sounds';

/** Pestaña «Registro»: estadísticas, últimas detecciones, exportación y borrado. */
export function DetectionLogPanel({
  logStatistics,
  recentDetections,
  commonNameForLabel,
  onExport,
  onDelete,
}: {
  logStatistics: DetectionStatistics | null;
  recentDetections: readonly DetectionRecord[];
  commonNameForLabel(label: string): string;
  onExport(exportKind: DetectionExportKind): void;
  onDelete(): void;
}) {
  const { t } = useTranslation(wildlifeSoundsNamespace);
  return (
    <>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('log.explanation')}
      </BodyText>
      {logStatistics ? (
        <BodyText>
          {t('log.statistics', {
            detections: logStatistics.detectionCount,
            species: logStatistics.distinctSpeciesCount,
          })}
        </BodyText>
      ) : null}
      {recentDetections.length === 0 ? (
        <BodyText tone="secondary">{t('log.empty')}</BodyText>
      ) : (
        <Card>
          <BodyText tone="secondary">{t('log.recent')}</BodyText>
          {recentDetections.map((detectionRecord) => (
            <View key={detectionRecord.id} style={styles.detectionRow}>
              <BodyText style={styles.detectionTime}>
                {clockTimeText(new Date(detectionRecord.detectedAtIso).getTime(), true)}
              </BodyText>
              <BodyText style={styles.detectionName} numberOfLines={1}>
                {detectionRecord.isCustomClass
                  ? `${detectionRecord.speciesLabel} · ${t('sessionList.customMark')}`
                  : commonNameForLabel(detectionRecord.speciesLabel)}
              </BodyText>
              <BodyText style={styles.detectionScore}>
                {detectionRecord.isCustomClass
                  ? similarityText(detectionRecord.speciesScore)
                  : detectionRecord.speciesScore.toFixed(1)}
              </BodyText>
            </View>
          ))}
        </Card>
      )}
      {logStatistics && logStatistics.detectionCount > 0 ? (
        <>
          <View style={styles.buttonRow}>
            <View style={styles.buttonCell}>
              <AppButton label={t('log.exportJsonl')} variant="secondary" onPress={() => onExport('jsonl')} />
            </View>
            <View style={styles.buttonCell}>
              <AppButton label={t('log.exportCsv')} variant="secondary" onPress={() => onExport('csv')} />
            </View>
          </View>
          <AppButton label={t('log.delete')} variant="danger" onPress={onDelete} />
        </>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  smallText: { fontSize: 13 },
  detectionRow: { flexDirection: 'row', gap: 8 },
  detectionTime: { fontVariant: ['tabular-nums'] },
  detectionName: { flex: 1 },
  detectionScore: { fontVariant: ['tabular-nums'] },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonCell: { flex: 1 },
});
