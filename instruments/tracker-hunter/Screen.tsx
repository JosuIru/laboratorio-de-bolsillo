import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, Platform, Pressable, StyleSheet, Switch, View } from 'react-native';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import type { FollowingCriteria, FollowingLevel } from '@/processing/bluetooth/followingHeuristic';
import { compareHeatTrend, heatToLevel, type HeatLevel, isSignalLost, rssiToHeat } from '@/processing/bluetooth/proximity';
import type { TrackerClassification } from '@/processing/bluetooth/trackerSignatures';
import { AppButton, BodyText, Card, LoadingState, ScreenContainer, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { trackerHunterInstrumentId } from './instrumentId';
import type { TrackerHunterMeasurementValues } from './schema';
import { useProximityBeeper } from './useProximityBeeper';
import { requestLocationForPlaces, scanTooFrequentlyErrorCode, type TrackerListEntry, useTrackerScan } from './useTrackerScan';

const followingThresholdOptionsMinutes: readonly number[] = [5, 10, 20, 30];
/** Android 12 (API 31) introdujo el permiso BLUETOOTH_SCAN sin ubicación. */
const androidTwelveApiLevel = 31;

const heatColorByLevel: Record<HeatLevel, string> = {
  cold: '#3B82F6',
  cool: '#0EA5A4',
  warm: '#F59E0B',
  hot: '#EF4444',
};

const followingColorByLevel: Record<FollowingLevel, string | null> = {
  following: '#DC2626',
  watch: '#D97706',
  passing: null,
};

/** Clave i18n del nombre del tipo de rastreador. */
export function trackerKindLabelKey(classification: TrackerClassification): string {
  switch (classification.kind) {
    case 'apple-find-my':
      switch (classification.appleDeviceType) {
        case 'airtag':
          return 'kind.airtag';
        case 'find-my-accessory':
          return 'kind.findMyAccessory';
        case 'airpods':
          return 'kind.airpods';
        case 'apple-device':
          return 'kind.appleDevice';
        default:
          return 'kind.appleFindMy';
      }
    case 'samsung-find':
      return 'kind.samsungFind';
    case 'tile':
      return 'kind.tile';
    case 'chipolo':
      return 'kind.chipolo';
    case 'google-find-hub':
      return 'kind.googleFindHub';
    case 'dult':
      return 'kind.dult';
    case 'samsung-device':
      return 'kind.samsungDevice';
  }
}

function toWholeMinutes(milliseconds: number): number {
  return Math.floor(milliseconds / 60_000);
}

export function TrackerHunterScreen({ saveMeasurement }: InstrumentScreenProps<TrackerHunterMeasurementValues>) {
  const { t } = useTranslation(trackerHunterInstrumentId);
  const themePalette = useThemePalette();
  const [followingThresholdMinutes, setFollowingThresholdMinutes] = useState(10);
  const [isLocationEnabled, setIsLocationEnabled] = useState(false);
  const [isLocationDenied, setIsLocationDenied] = useState(false);
  const [isSoundEnabled, setIsSoundEnabled] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const followingCriteria = useMemo<FollowingCriteria>(
    () => ({ minimumFollowingMinutes: followingThresholdMinutes, minimumDistinctPlaces: 2, minimumEpisodes: 2 }),
    [followingThresholdMinutes],
  );
  const trackerScan = useTrackerScan(followingCriteria, isLocationEnabled);
  const { phase, snapshot, entries, searchedGroupId, searchReading } = trackerScan;

  // Modo buscar: el grupo puede haber cambiado de id si su dirección rotó y se fundió.
  const activeSearchGroupId = searchReading?.groupId ?? searchedGroupId;
  const searchedEntry = activeSearchGroupId
    ? entries.find((entry) => entry.group.groupId === activeSearchGroupId) ?? null
    : null;
  const smoothedRssiDbm = searchReading?.smoothedRssi?.valueDbm ?? null;
  const isSearchSignalLost =
    phase !== 'scanning' ||
    isSignalLost(searchReading?.lastSeenMilliseconds ?? null, Math.max(snapshot.snapshotTakenMilliseconds, searchReading?.lastSeenMilliseconds ?? 0));
  const searchHeat = smoothedRssiDbm !== null && !isSearchSignalLost ? rssiToHeat(smoothedRssiDbm) : null;
  useProximityBeeper(searchedGroupId !== null && isSoundEnabled && phase === 'scanning', searchHeat);

  // Si la pantalla se apagara, la app pasaría a segundo plano y el escaneo se pararía.
  const isScreenNeededOn = phase === 'scanning';
  useEffect(() => {
    if (!isScreenNeededOn) return;
    const keepAwakeTag = 'tracker-hunter';
    activateKeepAwakeAsync(keepAwakeTag).catch(() => undefined);
    return () => {
      deactivateKeepAwake(keepAwakeTag).catch(() => undefined);
    };
  }, [isScreenNeededOn]);

  if (phase === 'unsupported') {
    return (
      <ScreenContainer>
        <Card>
          <SectionTitle>{t('unsupported.title')}</SectionTitle>
          <BodyText>{t('unsupported.body')}</BodyText>
        </Card>
        <LimitsCard />
      </ScreenContainer>
    );
  }
  if (phase === 'checking') return <LoadingState label={t('checking')} />;

  async function handleLocationToggle(shouldUseLocation: boolean) {
    if (!shouldUseLocation) {
      setIsLocationEnabled(false);
      return;
    }
    const isGranted = await requestLocationForPlaces();
    setIsLocationDenied(!isGranted);
    setIsLocationEnabled(isGranted);
  }

  async function handleSave() {
    setIsSaving(true);
    setStatusMessage(null);
    try {
      const dedicatedEntries = entries.filter((entry) => entry.group.classification.isDedicatedTracker);
      const trackersSummary = dedicatedEntries
        .map(
          (entry) =>
            `${t(trackerKindLabelKey(entry.group.classification))} (${t(`mode.${entry.group.classification.mode}`)}, ${t(
              `level.${entry.assessment.level}`,
            )}): ${Math.round(entry.assessment.observedMinutes)} min`,
        )
        .join('; ');
      await saveMeasurement({
        values: {
          trackerCount: dedicatedEntries.length,
          followingCount: dedicatedEntries.filter((entry) => entry.assessment.level === 'following').length,
          watchCount: dedicatedEntries.filter((entry) => entry.assessment.level === 'watch').length,
          otherDeviceCount: snapshot.otherDeviceCount,
          scanningMinutes: Math.round((snapshot.scanningMilliseconds / 60_000) * 10) / 10,
          followingThresholdMinutes,
          isLocationUsed: isLocationEnabled,
          trackersSummary,
        },
      });
      setStatusMessage(t('saved'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  const isScanning = phase === 'scanning';
  const scanningMinutes = toWholeMinutes(snapshot.scanningMilliseconds);
  const isLegacyAndroid = Platform.OS === 'android' && typeof Platform.Version === 'number' && Platform.Version < androidTwelveApiLevel;

  const statusCard = (
    <Card>
      {phase === 'no-bluetooth-hardware' ? <BodyText>{t('noHardware')}</BodyText> : null}
      {phase === 'needs-permission' ? (
        <>
          <BodyText>{isLegacyAndroid ? t('permission.explanationLegacy') : t('permission.explanation')}</BodyText>
          <AppButton label={t('permission.grant')} onPress={() => void trackerScan.requestPermission()} />
        </>
      ) : null}
      {phase === 'blocked-permission' ? (
        <>
          <BodyText>{t('permission.blocked')}</BodyText>
          <AppButton label={t('permission.openSettings')} onPress={() => void Linking.openSettings()} variant="secondary" />
          <AppButton label={t('retry')} onPress={() => void trackerScan.refreshAvailability()} />
        </>
      ) : null}
      {phase === 'bluetooth-off' ? (
        <>
          <BodyText>{t('bluetoothOff')}</BodyText>
          <AppButton label={t('retry')} onPress={() => void trackerScan.refreshAvailability()} />
        </>
      ) : null}
      {phase === 'error' ? (
        <>
          <BodyText tone="danger">
            {trackerScan.scanErrorCode === scanTooFrequentlyErrorCode
              ? t('scanTooFrequently')
              : trackerScan.scanErrorCode !== null
                ? t('scanError', { code: trackerScan.scanErrorCode })
                : t('error', { message: trackerScan.errorMessage ?? '' })}
          </BodyText>
          <AppButton label={t('retry')} onPress={() => void trackerScan.refreshAvailability()} />
        </>
      ) : null}
      {phase === 'idle' || phase === 'scanning' ? (
        <>
          <View accessibilityLiveRegion="polite">
            <BodyText tone={isScanning ? 'accent' : 'secondary'}>
              {isScanning ? t('scanning', { minutes: scanningMinutes }) : t('paused', { minutes: scanningMinutes })}
            </BodyText>
          </View>
          <BodyText>
            {t('summary', {
              trackers: entries.filter((entry) => entry.group.classification.isDedicatedTracker).length,
              others: snapshot.otherDeviceCount,
            })}
          </BodyText>
          <AppButton
            label={isScanning ? t('stop') : t('start')}
            onPress={isScanning ? trackerScan.stop : trackerScan.start}
            variant={isScanning ? 'secondary' : 'primary'}
          />
        </>
      ) : null}
    </Card>
  );

  if (searchedGroupId !== null) {
    const heatLevel = searchHeat !== null ? heatToLevel(searchHeat) : null;
    const heatTrend = smoothedRssiDbm !== null ? compareHeatTrend(smoothedRssiDbm, searchReading?.referenceRssiDbm ?? null) : 'steady';
    const heatColor = heatLevel ? heatColorByLevel[heatLevel] : themePalette.border;
    const searchedName = searchedEntry ? t(trackerKindLabelKey(searchedEntry.group.classification)) : '—';
    return (
      <ScreenContainer>
        <SectionTitle>{t('search.title', { name: searchedName })}</SectionTitle>
        {!isScanning ? statusCard : null}
        <Card style={{ ...styles.heatCard, borderColor: heatColor, borderWidth: 3 }}>
          <View accessibilityLiveRegion="polite" style={styles.heatContent}>
            {!isScanning ? (
              <BodyText tone="secondary">{t('search.notScanning')}</BodyText>
            ) : heatLevel === null ? (
              <BodyText tone="secondary">{smoothedRssiDbm === null ? t('search.waiting') : t('search.lost')}</BodyText>
            ) : (
              <>
                <BodyText style={{ ...styles.heatLabel, color: heatColor }}>{t(`search.${heatLevel}`)}</BodyText>
                <BodyText style={styles.trendLabel}>{t(`search.${heatTrend}`)}</BodyText>
              </>
            )}
          </View>
          <View style={[styles.heatTrack, { backgroundColor: themePalette.border }]}>
            <View style={[styles.heatFill, { width: `${Math.round((searchHeat ?? 0) * 100)}%`, backgroundColor: heatColor }]} />
          </View>
          {smoothedRssiDbm !== null ? (
            <BodyText tone="secondary" style={styles.smallText}>
              {t('search.rssi', { rssi: smoothedRssiDbm.toFixed(0) })}
            </BodyText>
          ) : null}
        </Card>
        <View style={styles.switchRow}>
          <BodyText style={styles.switchLabel}>{t('search.sound')}</BodyText>
          <Switch
            value={isSoundEnabled}
            onValueChange={setIsSoundEnabled}
            accessibilityLabel={t('search.sound')}
            trackColor={{ true: themePalette.accent, false: themePalette.border }}
          />
        </View>
        <BodyText tone="secondary" style={styles.smallText}>
          {t('search.tips')}
        </BodyText>
        <AppButton label={t('search.back')} onPress={() => trackerScan.selectSearchedGroup(null)} variant="secondary" />
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('intro')}
      </BodyText>
      {statusCard}

      {entries.length === 0 ? (
        <BodyText tone="secondary">{isScanning ? t('list.emptyWhileScanning') : t('list.empty')}</BodyText>
      ) : (
        entries.map((entry) => (
          <TrackerCard
            key={entry.group.groupId}
            entry={entry}
            nowMilliseconds={snapshot.snapshotTakenMilliseconds}
            onSearch={() => trackerScan.selectSearchedGroup(entry.group.groupId)}
          />
        ))
      )}

      {entries.length > 0 ? (
        <View style={styles.buttonRow}>
          <View style={styles.buttonCell}>
            <AppButton label={t('clear')} onPress={trackerScan.clearSession} variant="secondary" />
          </View>
          <View style={styles.buttonCell}>
            <AppButton label={t('save')} onPress={() => void handleSave()} isBusy={isSaving} />
          </View>
        </View>
      ) : null}
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}

      <Card>
        <BodyText>{t('settings.title')}</BodyText>
        <View style={styles.segmentedRow}>
          {followingThresholdOptionsMinutes.map((thresholdOptionMinutes) => {
            const isSelected = thresholdOptionMinutes === followingThresholdMinutes;
            return (
              <Pressable
                key={thresholdOptionMinutes}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSelected }}
                onPress={() => setFollowingThresholdMinutes(thresholdOptionMinutes)}
                style={[styles.segment, { borderColor: isSelected ? themePalette.accent : themePalette.border }]}>
                <BodyText tone={isSelected ? 'accent' : 'primary'}>
                  {t('settings.minutesOption', { minutes: thresholdOptionMinutes })}
                </BodyText>
              </Pressable>
            );
          })}
        </View>
        <BodyText tone="secondary" style={styles.smallText}>
          {t('settings.threshold', { minutes: followingThresholdMinutes })}
        </BodyText>
        <View style={styles.switchRow}>
          <BodyText style={styles.switchLabel}>{t('settings.useLocation')}</BodyText>
          <Switch
            value={isLocationEnabled}
            onValueChange={(shouldUseLocation) => void handleLocationToggle(shouldUseLocation)}
            accessibilityLabel={t('settings.useLocation')}
            trackColor={{ true: themePalette.accent, false: themePalette.border }}
          />
        </View>
        <BodyText tone="secondary" style={styles.smallText}>
          {isLocationDenied ? t('settings.locationDenied') : t('settings.useLocationHelp')}
        </BodyText>
      </Card>

      <LimitsCard />
    </ScreenContainer>
  );
}

function TrackerCard({
  entry,
  nowMilliseconds,
  onSearch,
}: {
  entry: TrackerListEntry;
  nowMilliseconds: number;
  onSearch(): void;
}) {
  const { t } = useTranslation(trackerHunterInstrumentId);
  const themePalette = useThemePalette();
  const { group, assessment } = entry;
  const levelColor = followingColorByLevel[assessment.level];
  const secondsSinceSeen = Math.max(0, Math.round((nowMilliseconds - group.lastSeenMilliseconds) / 1000));
  const isDedicated = group.classification.isDedicatedTracker;
  return (
    <Card style={levelColor ? { borderColor: levelColor, borderWidth: 2 } : undefined}>
      <View style={styles.cardHeader}>
        <BodyText style={styles.cardTitle} tone={isDedicated ? 'primary' : 'secondary'}>
          {t(trackerKindLabelKey(group.classification))}
        </BodyText>
        {isDedicated ? (
          <BodyText style={{ ...styles.levelBadge, color: levelColor ?? themePalette.textSecondary }}>
            {t(`level.${assessment.level}`)}
          </BodyText>
        ) : null}
      </View>
      <BodyText tone="secondary" style={styles.smallText}>
        {t(`mode.${group.classification.mode}`)} · {t('list.seenAgo', { seconds: secondsSinceSeen })} ·{' '}
        {t('list.rssi', { rssi: group.averageRssi.toFixed(0) })}
      </BodyText>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('list.details', {
          minutes: Math.floor(assessment.observedMinutes),
          addresses: group.addresses.length,
          episodes: assessment.episodeCount,
          places: assessment.distinctPlaceCount,
        })}
      </BodyText>
      {group.classification.batteryLevel && isDedicated ? (
        <BodyText tone="secondary" style={styles.smallText}>
          {t('list.battery', { level: t(`batteryLevel.${group.classification.batteryLevel}`) })}
        </BodyText>
      ) : null}
      {assessment.isCappedBecauseNearOwner ? (
        <BodyText tone="secondary" style={styles.smallText}>
          {t('list.nearOwnerNote')}
        </BodyText>
      ) : null}
      {isDedicated ? <AppButton label={t('list.search')} onPress={onSearch} variant="secondary" /> : null}
    </Card>
  );
}

function LimitsCard() {
  const { t } = useTranslation(trackerHunterInstrumentId);
  return (
    <Card>
      <BodyText>{t('limits.title')}</BodyText>
      {(['rotation', 'modes', 'rssi', 'foreground', 'notProof'] as const).map((limitKey) => (
        <BodyText key={limitKey} tone="secondary" style={styles.smallText}>
          {t(`limits.${limitKey}`)}
        </BodyText>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  smallText: { fontSize: 13 },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonCell: { flex: 1 },
  segmentedRow: { flexDirection: 'row', gap: 8 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10, borderWidth: 1.5 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  switchLabel: { flex: 1 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  cardTitle: { fontSize: 17, fontWeight: '600', flexShrink: 1 },
  levelBadge: { fontSize: 14, fontWeight: '700' },
  heatCard: { alignItems: 'stretch', paddingVertical: 24, gap: 12 },
  heatContent: { alignItems: 'center', minHeight: 90, justifyContent: 'center', gap: 4 },
  heatLabel: { fontSize: 40, lineHeight: 48, fontWeight: '800' },
  trendLabel: { fontSize: 20, fontWeight: '600' },
  heatTrack: { height: 14, borderRadius: 7, overflow: 'hidden' },
  heatFill: { height: 14, borderRadius: 7 },
});
