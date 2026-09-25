import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import {
  analyzeBandChannels,
  type BandChannelAnalysis,
  groupNetworksByPrimaryChannel,
  isChannelChangeWorthwhile,
  type NeighborNetwork,
  type RecommendableBand,
} from '@/processing/wifi/channelCongestion';
import { channelFromFrequency } from '@/processing/wifi/wifiBands';
import { AppButton, BodyText, Card, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import type { WifiConnectionInfo } from '../../modules/wifi-signal';
import { bandLabelKeys } from './SignalPanel';
import type { WifiScanStatus } from './useWifiScan';
import type { WifiPermissionState } from './useWifiPermissions';
import { wifiMapInstrumentId } from './wifiMapConfiguration';

const analyzedBands: readonly RecommendableBand[] = ['2.4GHz', '5GHz'];
/** Congestión que llena la barra. */
const congestionBarFullScale = 3;

function BandAnalysisCard({
  analysis,
  currentChannelNumber,
}: {
  analysis: BandChannelAnalysis;
  currentChannelNumber: number | null;
}) {
  const { t } = useTranslation(wifiMapInstrumentId);
  const themePalette = useThemePalette();
  const bestChannel = analysis.bestChannel;
  const shouldSuggestChange =
    currentChannelNumber !== null && isChannelChangeWorthwhile(analysis, currentChannelNumber);

  return (
    <Card>
      <BodyText style={styles.cardTitle}>
        {t('channels.bandTitle', { band: t(bandLabelKeys[analysis.band]), count: analysis.networkCount })}
      </BodyText>
      {bestChannel ? (
        <BodyText tone="accent">
          {t(bestChannel.isDfs ? 'channels.bestChannelDfs' : 'channels.bestChannel', {
            channel: bestChannel.channelNumber,
          })}
        </BodyText>
      ) : null}
      {currentChannelNumber !== null ? (
        <BodyText tone={shouldSuggestChange ? 'danger' : 'secondary'}>
          {shouldSuggestChange
            ? t('channels.changeSuggested', { current: currentChannelNumber })
            : t('channels.currentIsFine', { current: currentChannelNumber })}
        </BodyText>
      ) : null}
      {analysis.candidateChannels.map((candidateChannel) => {
        const fillFraction = Math.min(1, candidateChannel.congestionScore / congestionBarFullScale);
        const isBest = candidateChannel.channelNumber === bestChannel?.channelNumber;
        const isCurrent = candidateChannel.channelNumber === currentChannelNumber;
        return (
          <View
            key={candidateChannel.channelNumber}
            style={styles.barRow}
            accessible
            accessibilityLabel={t('channels.barLabel', {
              channel: candidateChannel.channelNumber,
              networks: candidateChannel.overlappingNetworkCount,
              score: candidateChannel.congestionScore.toFixed(1),
            })}>
            <BodyText style={styles.channelNumber} tone={isBest ? 'accent' : 'primary'}>
              {`${candidateChannel.channelNumber}${isCurrent ? '•' : ''}`}
            </BodyText>
            <View style={[styles.barTrack, { backgroundColor: themePalette.border }]}>
              <View
                style={[
                  styles.barFill,
                  {
                    width: `${Math.max(2, fillFraction * 100)}%`,
                    backgroundColor: isBest ? themePalette.success : themePalette.accent,
                  },
                ]}
              />
            </View>
            <BodyText tone="secondary" style={styles.barCount}>
              {candidateChannel.overlappingNetworkCount}
            </BodyText>
          </View>
        );
      })}
    </Card>
  );
}

export function ChannelsPanel({
  connection,
  permissionState,
  requestPermissions,
  neighborNetworks,
  scanStatus,
  requestScan,
  secondsUntilNextScan,
}: {
  connection: WifiConnectionInfo | null;
  permissionState: WifiPermissionState;
  requestPermissions(): Promise<void>;
  neighborNetworks: readonly NeighborNetwork[];
  scanStatus: WifiScanStatus;
  requestScan(): void;
  secondsUntilNextScan: number;
}) {
  const { t } = useTranslation(wifiMapInstrumentId);
  const ownBssid = connection?.bssid ?? null;
  const bandAnalyses = useMemo(
    () =>
      analyzedBands.map((band) => analyzeBandChannels(band, neighborNetworks, ownBssid !== null ? [ownBssid] : [])),
    [neighborNetworks, ownBssid],
  );
  const channelGroups = useMemo(() => groupNetworksByPrimaryChannel(neighborNetworks), [neighborNetworks]);
  const currentChannel = connection ? channelFromFrequency(connection.frequencyMhz) : null;

  if (!permissionState.canScan) {
    return (
      <Card>
        <BodyText>{t('channels.permissionNeeded')}</BodyText>
        {!permissionState.areLocationServicesEnabled && permissionState.isChecked ? (
          <BodyText tone="secondary">{t('channels.locationServicesOff')}</BodyText>
        ) : null}
        <AppButton label={t('channels.grantPermission')} onPress={() => void requestPermissions()} />
      </Card>
    );
  }

  const scanButtonLabel =
    scanStatus === 'scanning'
      ? t('channels.scanning')
      : secondsUntilNextScan > 0
        ? t('channels.scanWait', { seconds: secondsUntilNextScan })
        : t('channels.scan');

  return (
    <>
      <AppButton label={scanButtonLabel} onPress={requestScan} isBusy={scanStatus === 'scanning'} />
      {scanStatus === 'throttled' ? (
        <BodyText tone="secondary" style={styles.smallText}>
          {t('channels.throttled')}
        </BodyText>
      ) : null}
      {scanStatus === 'permission-missing' ? <BodyText tone="danger">{t('channels.permissionNeeded')}</BodyText> : null}

      {neighborNetworks.length === 0 ? (
        <BodyText tone="secondary">{t('channels.noNetworks')}</BodyText>
      ) : (
        <>
          {bandAnalyses.map((analysis) => (
            <BandAnalysisCard
              key={analysis.band}
              analysis={analysis}
              currentChannelNumber={currentChannel?.band === analysis.band ? currentChannel.channelNumber : null}
            />
          ))}
          <SectionTitle>{t('channels.neighborsTitle')}</SectionTitle>
          {channelGroups.map((channelGroup) => (
            <Card key={`${channelGroup.band}:${channelGroup.channelNumber}`}>
              <BodyText style={styles.cardTitle}>
                {t('signal.bandAndChannel', { band: t(bandLabelKeys[channelGroup.band]), channel: channelGroup.channelNumber })}
              </BodyText>
              {channelGroup.networks.map((network) => (
                <View key={network.bssid} style={styles.networkRow}>
                  <BodyText numberOfLines={1} style={styles.networkName}>
                    {network.ssid ?? t('channels.hiddenNetwork')}
                    {network.bssid === connection?.bssid ? ` · ${t('channels.yours')}` : ''}
                  </BodyText>
                  <BodyText tone="secondary" style={styles.networkDetails}>
                    {`${network.rssiDbm} dBm · ${network.channelWidthMhz} MHz`}
                  </BodyText>
                </View>
              ))}
            </Card>
          ))}
        </>
      )}
      <BodyText tone="secondary" style={styles.smallText}>
        {t('channels.honestyNote')}
      </BodyText>
    </>
  );
}

const styles = StyleSheet.create({
  smallText: { fontSize: 13 },
  cardTitle: { fontWeight: '600' },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  channelNumber: { width: 40, fontVariant: ['tabular-nums'] },
  barTrack: { flex: 1, height: 10, borderRadius: 5, overflow: 'hidden' },
  barFill: { height: 10, borderRadius: 5 },
  barCount: { width: 24, textAlign: 'right', fontVariant: ['tabular-nums'] },
  networkRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  networkName: { flex: 1 },
  networkDetails: { fontVariant: ['tabular-nums'] },
});
