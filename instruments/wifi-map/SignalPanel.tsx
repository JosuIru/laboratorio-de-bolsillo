import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { classifySignalQuality } from '@/processing/wifi/rssiStatistics';
import { channelFromFrequency, type WifiBand, wifiStandardLabel } from '@/processing/wifi/wifiBands';
import { SignalChart } from '@/ui/charts/SignalChart';
import { BodyText, Card } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import type { WifiConnectionSnapshot } from './useWifiConnection';
import { rssiChartDurationSeconds, rssiChartRangeDbm, wifiMapInstrumentId } from './wifiMapConfiguration';

const chartVerticalRange = { mode: 'fixed', ...rssiChartRangeDbm } as const;

/** Clave i18n de cada banda (el punto de «2.4GHz» no puede ir en una clave de i18next). */
export const bandLabelKeys: Record<WifiBand, string> = {
  '2.4GHz': 'bands.band24',
  '5GHz': 'bands.band5',
  '6GHz': 'bands.band6',
};

/** Formatea «2,4 GHz · canal 6» a partir de la frecuencia. */
export function useBandDescription() {
  const { t } = useTranslation(wifiMapInstrumentId);
  return (frequencyMhz: number) => {
    const channel = channelFromFrequency(frequencyMhz);
    if (!channel) return t('signal.frequencyOnly', { frequency: frequencyMhz });
    return t('signal.bandAndChannel', { band: t(bandLabelKeys[channel.band]), channel: channel.channelNumber });
  };
}

export function SignalPanel({ snapshot }: { snapshot: WifiConnectionSnapshot }) {
  const { t } = useTranslation(wifiMapInstrumentId);
  const themePalette = useThemePalette();
  const describeBand = useBandDescription();
  const { connection } = snapshot;

  if (!connection) {
    return (
      <Card>
        <BodyText>{snapshot.isWifiEnabled ? t('status.notConnected') : t('status.wifiOff')}</BodyText>
      </Card>
    );
  }

  const signalQuality = classifySignalQuality(connection.rssiDbm);
  const standardLabel = wifiStandardLabel(connection.wifiStandard);
  const linkSpeedParts = [
    connection.linkSpeedMbps !== null ? t('signal.linkSpeed', { speed: connection.linkSpeedMbps }) : null,
    connection.maxLinkSpeedMbps !== null ? t('signal.maxLinkSpeed', { speed: connection.maxLinkSpeedMbps }) : null,
  ].filter((part): part is string => part !== null);

  return (
    <>
      <Card style={styles.rssiCard}>
        <BodyText tone="secondary" style={styles.smallText}>
          {connection.ssid ?? t('signal.hiddenNetworkName')}
        </BodyText>
        <View accessibilityLiveRegion="polite">
          <BodyText style={styles.rssiValue}>{`${connection.rssiDbm} dBm`}</BodyText>
        </View>
        <BodyText tone={signalQuality === 'dead' || signalQuality === 'poor' ? 'danger' : 'accent'}>
          {t(`quality.${signalQuality}`)}
        </BodyText>
      </Card>

      <SignalChart
        series={[
          { values: snapshot.chartValues, color: themePalette.accent, sampleCount: snapshot.chartSampleCount },
        ]}
        height={120}
        verticalRange={chartVerticalRange}
        revision={snapshot.revision}
        unitLabel="dBm"
        horizontalLabels={[`−${rssiChartDurationSeconds} s`, t('signal.now')]}
        accessibilityLabel={t('signal.chart')}
      />

      <Card>
        <BodyText>{describeBand(connection.frequencyMhz)}</BodyText>
        {linkSpeedParts.length > 0 ? <BodyText tone="secondary">{linkSpeedParts.join(' · ')}</BodyText> : null}
        {connection.txLinkSpeedMbps !== null && connection.rxLinkSpeedMbps !== null ? (
          <BodyText tone="secondary">
            {t('signal.txRxSpeed', { tx: connection.txLinkSpeedMbps, rx: connection.rxLinkSpeedMbps })}
          </BodyText>
        ) : null}
        <BodyText tone="secondary">{standardLabel ?? t('signal.unknownStandard')}</BodyText>
      </Card>

      <BodyText tone="secondary" style={styles.smallText}>
        {t('signal.explanation')}
      </BodyText>
    </>
  );
}

const styles = StyleSheet.create({
  rssiCard: { alignItems: 'center', paddingVertical: 20, gap: 4 },
  rssiValue: { fontSize: 44, lineHeight: 52, fontWeight: '700', fontVariant: ['tabular-nums'] },
  smallText: { fontSize: 13 },
});
