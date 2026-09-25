import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import { flattenRooms, isPointInsideHouse, type PlanPoint, roomFromCorners } from '@/processing/wifi/floorPlan';
import { heatmapColorScaleDbm } from '@/processing/wifi/heatmapInterpolation';
import { minimumPointsForRecommendation } from '@/processing/wifi/repeaterRecommendation';
import { deadZoneThresholdDbm, summarizeRssiSamples } from '@/processing/wifi/rssiStatistics';
import { AppButton, BodyText, Card } from '@/ui/components';

import { FloorPlanCanvas } from './FloorPlanCanvas';
import type { WifiMapMeasurementValues } from './schema';
import { SegmentedChoice } from './SegmentedChoice';
import type { FloorPlanState } from './useFloorPlanState';
import type { WifiConnectionSnapshot } from './useWifiConnection';
import {
  planGridColumnCount,
  planGridRowCount,
  pointAveragingDurationMilliseconds,
  wifiMapInstrumentId,
} from './wifiMapConfiguration';

type PlanEditMode = 'rooms' | 'measure';
const planEditModes: readonly PlanEditMode[] = ['rooms', 'measure'];

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function roundCoordinate(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function LegendBar() {
  const { t } = useTranslation(wifiMapInstrumentId);
  const legendSteps = [heatmapColorScaleDbm.worst, heatmapColorScaleDbm.middle, heatmapColorScaleDbm.best];
  return (
    <View style={styles.legendRow}>
      <View style={[styles.legendSwatch, { backgroundColor: '#C82828' }]} />
      <View style={[styles.legendSwatch, { backgroundColor: '#EBC832' }]} />
      <View style={[styles.legendSwatch, { backgroundColor: '#28AA50' }]} />
      <BodyText tone="secondary" style={styles.smallText}>
        {t('map.legend', {
          worst: legendSteps[0],
          middle: legendSteps[1],
          best: legendSteps[2],
          dead: deadZoneThresholdDbm,
        })}
      </BodyText>
    </View>
  );
}

export function MapPanel({
  floorPlan,
  snapshot,
  collectRssiSamples,
  saveMeasurement,
}: {
  floorPlan: FloorPlanState;
  snapshot: WifiConnectionSnapshot;
  collectRssiSamples(durationMilliseconds: number): Promise<number[]>;
  saveMeasurement: InstrumentScreenProps<WifiMapMeasurementValues>['saveMeasurement'];
}) {
  const { t } = useTranslation(wifiMapInstrumentId);
  const [planEditMode, setPlanEditMode] = useState<PlanEditMode>(() =>
    floorPlan.rooms.length === 0 && floorPlan.mappedPoints.length === 0 ? 'rooms' : 'measure',
  );
  const [measuringPoint, setMeasuringPoint] = useState<PlanPoint | null>(null);
  const [measuringSecondsLeft, setMeasuringSecondsLeft] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const {
    rooms,
    mappedPoints,
    pendingRoomCorner,
    heatmapGrid,
    deadZoneSummary,
    repeaterRecommendation,
    hasMixedFrequencies,
  } = floorPlan;

  useEffect(() => {
    if (!measuringPoint) return;
    const measuringStartedAt = Date.now();
    const countdownInterval = setInterval(() => {
      const elapsedMilliseconds = Date.now() - measuringStartedAt;
      setMeasuringSecondsLeft(Math.max(0, Math.ceil((pointAveragingDurationMilliseconds - elapsedMilliseconds) / 1000)));
    }, 250);
    return () => clearInterval(countdownInterval);
  }, [measuringPoint]);

  async function measureAt(point: PlanPoint) {
    const connectionAtStart = snapshot.connection;
    if (!connectionAtStart) {
      setStatusMessage(t('map.needsConnection'));
      return;
    }
    if (!isPointInsideHouse(point, rooms)) {
      setStatusMessage(t('map.tapInsideRoom'));
      return;
    }
    setStatusMessage(null);
    setMeasuringSecondsLeft(Math.ceil(pointAveragingDurationMilliseconds / 1000));
    setMeasuringPoint(point);
    const rssiSamples = await collectRssiSamples(pointAveragingDurationMilliseconds);
    setMeasuringPoint(null);
    const rssiSummary = summarizeRssiSamples(rssiSamples);
    if (!rssiSummary) {
      setStatusMessage(t('map.noSamples'));
      return;
    }
    floorPlan.addPoint({
      ...point,
      rssiDbm: rssiSummary.meanDbm,
      sampleCount: rssiSummary.sampleCount,
      frequencyMhz: connectionAtStart.frequencyMhz,
    });
    setStatusMessage(t('map.pointAdded', { rssi: Math.round(rssiSummary.meanDbm), spread: rssiSummary.standardDeviationDb.toFixed(1) }));
  }

  function handlePlanPress(point: PlanPoint) {
    if (measuringPoint) return;
    if (planEditMode === 'rooms') {
      if (!pendingRoomCorner) {
        floorPlan.setPendingRoomCorner(point);
        setStatusMessage(t('map.secondCorner'));
        return;
      }
      const newRoom = roomFromCorners(pendingRoomCorner, point, planGridColumnCount, planGridRowCount);
      floorPlan.setPendingRoomCorner(null);
      if (newRoom) {
        floorPlan.addRoom(newRoom);
        setStatusMessage(null);
      } else {
        setStatusMessage(t('map.roomTooSmall'));
      }
      return;
    }
    void measureAt(point);
  }

  async function handleSave() {
    const rssiSummary = summarizeRssiSamples(mappedPoints.map((mappedPoint) => mappedPoint.rssiDbm));
    if (!rssiSummary) return;
    setIsSaving(true);
    try {
      const recommendedLocation =
        repeaterRecommendation?.status === 'recommended' ? repeaterRecommendation.location : null;
      await saveMeasurement({
        values: {
          pointCount: mappedPoints.length,
          medianRssiDbm: roundToTenth(rssiSummary.medianDbm),
          weakestRssiDbm: roundToTenth(rssiSummary.minimumDbm),
          strongestRssiDbm: roundToTenth(rssiSummary.maximumDbm),
          deadZonePercent: roundToTenth((deadZoneSummary?.deadFraction ?? 0) * 100),
          pointXs: mappedPoints.map((mappedPoint) => roundCoordinate(mappedPoint.x)),
          pointYs: mappedPoints.map((mappedPoint) => roundCoordinate(mappedPoint.y)),
          pointRssisDbm: mappedPoints.map((mappedPoint) => roundToTenth(mappedPoint.rssiDbm)),
          roomCoordinates: flattenRooms(rooms).map(roundCoordinate),
          repeaterX: recommendedLocation ? roundCoordinate(recommendedLocation.x) : -1,
          repeaterY: recommendedLocation ? roundCoordinate(recommendedLocation.y) : -1,
          networkName: snapshot.connection?.ssid ?? '',
          frequencyMhz: mappedPoints[0]?.frequencyMhz ?? 0,
        },
      });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  function describeRecommendation(): string {
    if (!repeaterRecommendation) return t('map.recommendation.needPoints', { count: minimumPointsForRecommendation });
    switch (repeaterRecommendation.status) {
      case 'not-enough-points':
        return t('map.recommendation.needPoints', { count: minimumPointsForRecommendation });
      case 'no-dead-zone':
        return t('map.recommendation.noDeadZone');
      case 'no-good-spot':
        return t('map.recommendation.noGoodSpot');
      case 'recommended':
        return t('map.recommendation.recommended', { rssi: Math.round(repeaterRecommendation.rssiDbm) });
    }
  }

  const repeaterLocation = repeaterRecommendation?.status === 'recommended' ? repeaterRecommendation.location : null;
  const isMeasuring = measuringPoint !== null;

  return (
    <>
      <SegmentedChoice
        options={planEditModes}
        selectedOption={planEditMode}
        onSelect={(nextMode) => {
          setPlanEditMode(nextMode);
          floorPlan.setPendingRoomCorner(null);
          setStatusMessage(null);
        }}
        labelFor={(editMode) => t(`map.modes.${editMode}`)}
      />
      <BodyText tone="secondary" style={styles.smallText}>
        {planEditMode === 'rooms' ? t('map.roomsHelp') : t('map.measureHelp', { seconds: pointAveragingDurationMilliseconds / 1000 })}
      </BodyText>

      <FloorPlanCanvas
        rooms={rooms}
        measurementPoints={mappedPoints}
        heatmapGrid={heatmapGrid}
        repeaterLocation={repeaterLocation}
        pendingRoomCorner={pendingRoomCorner}
        measuringPoint={measuringPoint}
        onPlanPress={handlePlanPress}
        accessibilityLabel={t('map.planLabel')}
      />
      <LegendBar />

      <View accessibilityLiveRegion="polite">
        {isMeasuring ? (
          <BodyText tone="accent">{t('map.measuring', { seconds: measuringSecondsLeft })}</BodyText>
        ) : statusMessage ? (
          <BodyText tone="secondary">{statusMessage}</BodyText>
        ) : null}
      </View>

      <View style={styles.buttonRow}>
        {planEditMode === 'rooms' ? (
          <>
            <View style={styles.buttonCell}>
              <AppButton label={t('map.undoRoom')} variant="secondary" onPress={floorPlan.removeLastRoom} isDisabled={rooms.length === 0} />
            </View>
            <View style={styles.buttonCell}>
              <AppButton label={t('map.clearRooms')} variant="danger" onPress={floorPlan.clearRooms} isDisabled={rooms.length === 0} />
            </View>
          </>
        ) : (
          <>
            <View style={styles.buttonCell}>
              <AppButton
                label={t('map.undoPoint')}
                variant="secondary"
                onPress={floorPlan.removeLastPoint}
                isDisabled={mappedPoints.length === 0 || isMeasuring}
              />
            </View>
            <View style={styles.buttonCell}>
              <AppButton
                label={t('map.clearPoints')}
                variant="danger"
                onPress={floorPlan.clearPoints}
                isDisabled={mappedPoints.length === 0 || isMeasuring}
              />
            </View>
          </>
        )}
      </View>

      <Card>
        <BodyText>{t('map.pointCount', { count: mappedPoints.length })}</BodyText>
        {deadZoneSummary ? (
          <BodyText tone={deadZoneSummary.deadCellCount > 0 ? 'danger' : 'secondary'}>
            {t('map.deadZones', { percent: Math.round(deadZoneSummary.deadFraction * 100), threshold: deadZoneThresholdDbm })}
          </BodyText>
        ) : null}
        <BodyText tone="secondary">{describeRecommendation()}</BodyText>
        {hasMixedFrequencies ? <BodyText tone="danger">{t('map.mixedFrequencies')}</BodyText> : null}
      </Card>

      <AppButton
        label={t('map.save')}
        onPress={() => void handleSave()}
        isBusy={isSaving}
        isDisabled={mappedPoints.length === 0 || isMeasuring}
      />
      <BodyText tone="secondary" style={styles.smallText}>
        {t('map.honestyNote')}
      </BodyText>
    </>
  );
}

const styles = StyleSheet.create({
  smallText: { fontSize: 13 },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonCell: { flex: 1 },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
  legendSwatch: { width: 14, height: 14, borderRadius: 3 },
});
