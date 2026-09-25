import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, StyleSheet } from 'react-native';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import { AppButton, BodyText, Card, ScreenContainer } from '@/ui/components';

import { isWifiSignalAvailable } from '../../modules/wifi-signal';
import { ChannelsPanel } from './ChannelsPanel';
import { MapPanel } from './MapPanel';
import type { WifiMapMeasurementValues } from './schema';
import { SegmentedChoice } from './SegmentedChoice';
import { SignalPanel } from './SignalPanel';
import { useFloorPlanState } from './useFloorPlanState';
import { useWifiConnection } from './useWifiConnection';
import { useWifiPermissions } from './useWifiPermissions';
import { useWifiScan } from './useWifiScan';
import { wifiMapInstrumentId } from './wifiMapConfiguration';

export { wifiMapInstrumentId };

type WifiMapMode = 'signal' | 'map' | 'channels';
const wifiMapModes: readonly WifiMapMode[] = ['signal', 'map', 'channels'];

export function WifiMapScreen({ saveMeasurement }: InstrumentScreenProps<WifiMapMeasurementValues>) {
  const { t } = useTranslation(wifiMapInstrumentId);
  const [wifiMapMode, setWifiMapMode] = useState<WifiMapMode>('signal');
  const { snapshot, collectRssiSamples } = useWifiConnection(isWifiSignalAvailable);
  const { permissionState, requestPermissions } = useWifiPermissions();
  const { neighborNetworks, scanStatus, requestScan, secondsUntilNextScan } = useWifiScan(
    isWifiSignalAvailable && permissionState.canScan,
  );
  const floorPlan = useFloorPlanState();

  if (!isWifiSignalAvailable) {
    return (
      <ScreenContainer>
        <Card>
          <BodyText>{Platform.OS === 'android' ? t('status.moduleMissing') : t('status.androidOnly')}</BodyText>
        </Card>
      </ScreenContainer>
    );
  }

  const isMissingNetworkName =
    permissionState.isChecked && snapshot.connection !== null && !permissionState.hasLocationPermission;

  return (
    <ScreenContainer>
      <SegmentedChoice
        options={wifiMapModes}
        selectedOption={wifiMapMode}
        onSelect={setWifiMapMode}
        labelFor={(mode) => t(`modes.${mode}`)}
      />

      {isMissingNetworkName && wifiMapMode === 'signal' ? (
        <Card>
          <BodyText tone="secondary" style={styles.smallText}>
            {t('status.locationForName')}
          </BodyText>
          <AppButton label={t('channels.grantPermission')} variant="secondary" onPress={() => void requestPermissions()} />
        </Card>
      ) : null}

      {wifiMapMode === 'signal' ? <SignalPanel snapshot={snapshot} /> : null}
      {wifiMapMode === 'map' ? (
        <MapPanel
          floorPlan={floorPlan}
          snapshot={snapshot}
          collectRssiSamples={collectRssiSamples}
          saveMeasurement={saveMeasurement}
        />
      ) : null}
      {wifiMapMode === 'channels' ? (
        <ChannelsPanel
          connection={snapshot.connection}
          permissionState={permissionState}
          requestPermissions={requestPermissions}
          neighborNetworks={neighborNetworks}
          scanStatus={scanStatus}
          requestScan={requestScan}
          secondsUntilNextScan={secondsUntilNextScan}
        />
      ) : null}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  smallText: { fontSize: 13 },
});
