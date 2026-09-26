import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { BodyText, Card, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { ChipSelector } from './ChipSelector';
import { similarityText } from './customSounds';
import {
  aggregateSessionSpecies,
  buildSessionTimeline,
  type SessionDetection,
  type SessionListOrder,
  type TimelineRow,
} from './sessionTimeline';

const wildlifeSoundsNamespace = 'wildlife-sounds';
const listOrders: readonly SessionListOrder[] = ['by-time', 'by-count'];
const timelineRowHeight = 22;
const timelineMarkWidth = 3;

export function clockTimeText(timestamp: number, withSeconds = false): string {
  const clockDate = new Date(timestamp);
  const twoDigits = (numericValue: number) => String(numericValue).padStart(2, '0');
  const hoursAndMinutes = `${twoDigits(clockDate.getHours())}:${twoDigits(clockDate.getMinutes())}`;
  return withSeconds ? `${hoursAndMinutes}:${twoDigits(clockDate.getSeconds())}` : hoursAndMinutes;
}

/** Lista de especies de la sesión (ordenable) y tira con cuándo se oyó cada una. */
export function SessionPanel({
  sessionDetections,
  sessionStartTimestamp,
  sessionEndTimestamp,
  commonNameForLabel,
}: {
  sessionDetections: readonly SessionDetection[];
  sessionStartTimestamp: number;
  sessionEndTimestamp: number;
  commonNameForLabel(label: string): string;
}) {
  const { t } = useTranslation(wildlifeSoundsNamespace);
  const themePalette = useThemePalette();
  const [listOrder, setListOrder] = useState<SessionListOrder>('by-time');
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);

  const speciesEntries = useMemo(
    () => aggregateSessionSpecies(sessionDetections, listOrder),
    [sessionDetections, listOrder],
  );
  const sessionTimeline = useMemo(
    () => buildSessionTimeline(sessionDetections, sessionStartTimestamp, sessionEndTimestamp),
    [sessionDetections, sessionStartTimestamp, sessionEndTimestamp],
  );

  const nameFor = (entry: { label: string; isCustomClass: boolean }) =>
    entry.isCustomClass ? entry.label : commonNameForLabel(entry.label);
  const toggleHighlight = (entryKey: string) =>
    setHighlightedKey((previousKey) => (previousKey === entryKey ? null : entryKey));

  if (speciesEntries.length === 0) {
    return <BodyText tone="secondary">{t('sessionList.empty')}</BodyText>;
  }

  return (
    <>
      <SectionTitle>{t('sessionList.timelineTitle')}</SectionTitle>
      <Card>
        {sessionTimeline.rows.map((timelineRow) => (
          <TimelineRowView
            key={timelineRow.key}
            timelineRow={timelineRow}
            displayName={nameFor(timelineRow)}
            isHighlighted={highlightedKey === timelineRow.key}
            isDimmed={highlightedKey !== null && highlightedKey !== timelineRow.key}
            onPress={() => toggleHighlight(timelineRow.key)}
          />
        ))}
        <View style={styles.timelineAxis}>
          <BodyText tone="secondary" style={styles.smallText}>
            {clockTimeText(sessionTimeline.startTimestamp)}
          </BodyText>
          <BodyText tone="secondary" style={styles.smallText}>
            {clockTimeText(sessionTimeline.endTimestamp)}
          </BodyText>
        </View>
        {sessionTimeline.hiddenSpeciesCount > 0 ? (
          <BodyText tone="secondary" style={styles.smallText}>
            {t('sessionList.hiddenSpecies', { count: sessionTimeline.hiddenSpeciesCount })}
          </BodyText>
        ) : null}
        <BodyText tone="secondary" style={styles.smallText}>
          {t('sessionList.timelineHelp')}
        </BodyText>
      </Card>

      <SectionTitle>{t('sessionList.title')}</SectionTitle>
      <ChipSelector
        options={listOrders}
        selectedOption={listOrder}
        labelFor={(order) => t(order === 'by-time' ? 'sessionList.orderByTime' : 'sessionList.orderByCount')}
        onSelect={setListOrder}
      />
      <Card>
        {speciesEntries.map((entry) => {
          const isHighlighted = highlightedKey === entry.key;
          return (
            <Pressable
              key={entry.key}
              accessibilityRole="button"
              accessibilityState={{ selected: isHighlighted }}
              onPress={() => toggleHighlight(entry.key)}
              style={[styles.speciesRow, isHighlighted ? { backgroundColor: themePalette.background } : null]}>
              <View style={styles.speciesHeader}>
                <BodyText style={styles.speciesName} numberOfLines={1}>
                  {nameFor(entry)}
                </BodyText>
                <BodyText style={styles.speciesCount}>{`×${entry.detectionCount}`}</BodyText>
              </View>
              <BodyText tone="secondary" style={styles.smallText}>
                {t('sessionList.rowDetails', {
                  first: clockTimeText(entry.firstTimestamp),
                  last: clockTimeText(entry.lastTimestamp),
                  best: entry.isCustomClass ? similarityText(entry.bestScore) : entry.bestScore.toFixed(1),
                })}
                {entry.isCustomClass ? ` · ${t('sessionList.customMark')}` : ''}
              </BodyText>
            </Pressable>
          );
        })}
      </Card>
    </>
  );
}

function TimelineRowView({
  timelineRow,
  displayName,
  isHighlighted,
  isDimmed,
  onPress,
}: {
  timelineRow: TimelineRow;
  displayName: string;
  isHighlighted: boolean;
  isDimmed: boolean;
  onPress(): void;
}) {
  const themePalette = useThemePalette();
  const markColor = timelineRow.isCustomClass ? themePalette.success : themePalette.accent;
  const maximumBinCount = Math.max(1, ...timelineRow.marks.map((timelineMark) => timelineMark.detectionCount));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: isHighlighted }}
      accessibilityLabel={`${displayName}: ${timelineRow.totalDetectionCount}`}
      onPress={onPress}
      style={[styles.timelineRow, { opacity: isDimmed ? 0.35 : 1 }]}>
      <BodyText
        style={StyleSheet.flatten([styles.timelineLabel, isHighlighted ? styles.highlightedLabel : null])}
        numberOfLines={1}>
        {displayName}
      </BodyText>
      <View style={[styles.timelineTrack, { backgroundColor: themePalette.border }]}>
        {timelineRow.marks.map((timelineMark) => (
          <View
            key={timelineMark.positionFraction}
            style={[
              styles.timelineMark,
              {
                left: `${timelineMark.positionFraction * 100}%`,
                backgroundColor: markColor,
                // Más detecciones en el tramo, marca más opaca.
                opacity: 0.4 + (0.6 * timelineMark.detectionCount) / maximumBinCount,
              },
            ]}
          />
        ))}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  smallText: { fontSize: 13 },
  timelineRow: { flexDirection: 'row', alignItems: 'center', gap: 8, height: timelineRowHeight + 6 },
  timelineLabel: { width: 110, fontSize: 13 },
  highlightedLabel: { fontWeight: '700' },
  timelineTrack: { flex: 1, height: timelineRowHeight, borderRadius: 4, overflow: 'hidden' },
  timelineMark: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: timelineMarkWidth,
    marginLeft: -timelineMarkWidth / 2,
  },
  timelineAxis: { flexDirection: 'row', justifyContent: 'space-between', marginLeft: 118 },
  speciesRow: { paddingVertical: 4, paddingHorizontal: 4, borderRadius: 6 },
  speciesHeader: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  speciesName: { flex: 1, fontWeight: '600' },
  speciesCount: { fontVariant: ['tabular-nums'] },
});
