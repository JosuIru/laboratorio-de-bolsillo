import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppButton, BodyText, Card } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { similarityText } from './customSounds';
import type { DetectionRecord, DetectionVerdict } from './detectionLog';
import type { DetectionStatistics } from './detectionStore';
import { clockTimeText } from './SessionPanel';
import type { DetectionExportKind } from './shareDetectionFiles';

const wildlifeSoundsNamespace = 'wildlife-sounds';

const verdictOptions: readonly DetectionVerdict[] = ['correct', 'incorrect'];
const verdictSymbolByKind: Record<DetectionVerdict, string> = { correct: '✓', incorrect: '✗' };

/**
 * Pestaña «Registro»: estadísticas, últimas detecciones (cada una se puede marcar como correcta
 * o incorrecta), exportación y borrado.
 */
export function DetectionLogPanel({
  logStatistics,
  recentDetections,
  commonNameForLabel,
  onExport,
  onDelete,
  onSetVerdict,
}: {
  logStatistics: DetectionStatistics | null;
  recentDetections: readonly DetectionRecord[];
  commonNameForLabel(label: string): string;
  onExport(exportKind: DetectionExportKind): void;
  onDelete(): void;
  /** `null` quita la marca (se pulsa otra vez la que ya estaba). */
  onSetVerdict(detectionId: number, userVerdict: DetectionVerdict | null): void;
}) {
  const { t } = useTranslation(wildlifeSoundsNamespace);
  const themePalette = useThemePalette();
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
          {logStatistics.correctCount + logStatistics.incorrectCount > 0
            ? ` · ${t('log.verdictStatistics', {
                correct: logStatistics.correctCount,
                incorrect: logStatistics.incorrectCount,
              })}`
            : ''}
        </BodyText>
      ) : null}
      {recentDetections.length === 0 ? (
        <BodyText tone="secondary">{t('log.empty')}</BodyText>
      ) : (
        <Card>
          <BodyText tone="secondary">{t('log.recent')}</BodyText>
          <BodyText tone="secondary" style={styles.smallText}>
            {t('log.verdictHelp')}
          </BodyText>
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
              {verdictOptions.map((verdictOption) => {
                const isSelected = detectionRecord.userVerdict === verdictOption;
                const selectedColor = verdictOption === 'correct' ? themePalette.success : themePalette.danger;
                return (
                  <Pressable
                    key={verdictOption}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                    accessibilityLabel={t(`log.verdict.${verdictOption}`)}
                    hitSlop={6}
                    onPress={() => onSetVerdict(detectionRecord.id, isSelected ? null : verdictOption)}
                    style={[
                      styles.verdictButton,
                      {
                        borderColor: isSelected ? selectedColor : themePalette.border,
                        backgroundColor: isSelected ? selectedColor : 'transparent',
                      },
                    ]}>
                    <BodyText
                      style={StyleSheet.flatten([
                        styles.verdictSymbol,
                        { color: isSelected ? themePalette.background : themePalette.textSecondary },
                      ])}>
                      {verdictSymbolByKind[verdictOption]}
                    </BodyText>
                  </Pressable>
                );
              })}
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
  detectionRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 },
  detectionTime: { fontVariant: ['tabular-nums'] },
  detectionName: { flex: 1 },
  detectionScore: { fontVariant: ['tabular-nums'] },
  verdictButton: {
    width: 32,
    height: 28,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  verdictSymbol: { fontSize: 15, fontWeight: '700' },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonCell: { flex: 1 },
});
