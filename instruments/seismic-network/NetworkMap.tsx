import { useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';

import type { PlanePoint, SearchBounds } from '@/processing/seismology/localization';
import { useThemePalette } from '@/ui/theme';

import { formatDecimal } from './stationMessages';

export interface MapStation extends PlanePoint {
  stationName: string;
  /** Texto bajo el nombre (hora de llegada o residuo). */
  detailLabel?: string;
}

interface NetworkMapProps {
  stations: readonly MapStation[];
  bounds: SearchBounds;
  estimatedSource?: PlanePoint | null;
  knownSource?: PlanePoint | null;
  compatibleRegion?: readonly PlanePoint[];
  accessibilityLabel: string;
}

const stationMarkerSize = 14;
const sourceMarkerSize = 22;
const regionDotSize = 6;
const maximumMapHeight = 360;
const regionColor = '#F59E0B';
const sourceColor = '#DC2626';
const knownSourceColor = '#16A34A';

/**
 * Plano de la red dibujado con vistas: estaciones, zona compatible con las medidas y foco.
 * La escala es la misma en x y en y (1 m mide lo mismo en las dos direcciones).
 */
export function NetworkMap({ stations, bounds, estimatedSource, knownSource, compatibleRegion = [], accessibilityLabel }: NetworkMapProps) {
  const themePalette = useThemePalette();
  const [mapWidth, setMapWidth] = useState(0);
  const boundsWidthMeters = Math.max(bounds.maximumXMeters - bounds.minimumXMeters, 1e-6);
  const boundsHeightMeters = Math.max(bounds.maximumYMeters - bounds.minimumYMeters, 1e-6);
  const pixelsPerMeter = Math.min(mapWidth / boundsWidthMeters, maximumMapHeight / boundsHeightMeters);
  const drawingWidth = boundsWidthMeters * pixelsPerMeter;
  const drawingHeight = boundsHeightMeters * pixelsPerMeter;

  /** y crece hacia arriba en el plano, como en clase de matemáticas. */
  const toScreen = (point: PlanePoint) => ({
    left: (point.xMeters - bounds.minimumXMeters) * pixelsPerMeter,
    top: (bounds.maximumYMeters - point.yMeters) * pixelsPerMeter,
  });

  const handleLayout = (layoutEvent: LayoutChangeEvent) => setMapWidth(layoutEvent.nativeEvent.layout.width);

  return (
    <View onLayout={handleLayout} accessible accessibilityLabel={accessibilityLabel} style={styles.container}>
      {mapWidth > 0 ? (
        <View
          style={[
            styles.drawing,
            { width: drawingWidth, height: drawingHeight, borderColor: themePalette.border, backgroundColor: themePalette.surface },
          ]}>
          {compatibleRegion.map((regionPoint, regionIndex) => {
            const screenPosition = toScreen(regionPoint);
            return (
              <View
                key={`region-${regionIndex}`}
                style={[
                  styles.regionDot,
                  { left: screenPosition.left - regionDotSize / 2, top: screenPosition.top - regionDotSize / 2 },
                ]}
              />
            );
          })}
          {knownSource ? (
            <View
              style={[
                styles.sourceMarker,
                {
                  borderColor: knownSourceColor,
                  left: toScreen(knownSource).left - sourceMarkerSize / 2,
                  top: toScreen(knownSource).top - sourceMarkerSize / 2,
                },
              ]}
            />
          ) : null}
          {stations.map((station, stationIndex) => {
            const screenPosition = toScreen(station);
            return (
              <View
                key={`station-${stationIndex}`}
                style={[styles.stationGroup, { left: screenPosition.left - 40, top: screenPosition.top - stationMarkerSize / 2 }]}>
                <View style={[styles.stationMarker, { backgroundColor: themePalette.accent }]} />
                <Text style={[styles.stationLabel, { color: themePalette.textPrimary }]} numberOfLines={1}>
                  {station.stationName}
                </Text>
                {station.detailLabel ? (
                  <Text style={[styles.stationDetail, { color: themePalette.textSecondary }]} numberOfLines={1}>
                    {station.detailLabel}
                  </Text>
                ) : null}
              </View>
            );
          })}
          {estimatedSource ? (
            <View
              style={[
                styles.estimatedSource,
                {
                  left: toScreen(estimatedSource).left - sourceMarkerSize / 2,
                  top: toScreen(estimatedSource).top - sourceMarkerSize / 2,
                },
              ]}>
              <Text style={styles.estimatedSourceGlyph}>✕</Text>
            </View>
          ) : null}
          <Text style={[styles.cornerLabel, styles.bottomLeft, { color: themePalette.textSecondary }]}>
            ({formatDecimal(bounds.minimumXMeters, 1)}; {formatDecimal(bounds.minimumYMeters, 1)}) m
          </Text>
          <Text style={[styles.cornerLabel, styles.topRight, { color: themePalette.textSecondary }]}>
            ({formatDecimal(bounds.maximumXMeters, 1)}; {formatDecimal(bounds.maximumYMeters, 1)}) m
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export const networkMapColors = { region: regionColor, estimatedSource: sourceColor, knownSource: knownSourceColor };

const styles = StyleSheet.create({
  container: { width: '100%', alignItems: 'center' },
  drawing: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, overflow: 'hidden' },
  regionDot: {
    position: 'absolute',
    width: regionDotSize,
    height: regionDotSize,
    borderRadius: regionDotSize / 2,
    backgroundColor: regionColor,
    opacity: 0.45,
  },
  stationGroup: { position: 'absolute', width: 80, alignItems: 'center' },
  stationMarker: { width: stationMarkerSize, height: stationMarkerSize, borderRadius: 3, transform: [{ rotate: '45deg' }] },
  stationLabel: { fontSize: 12, fontWeight: '600' },
  stationDetail: { fontSize: 10, fontVariant: ['tabular-nums'] },
  sourceMarker: {
    position: 'absolute',
    width: sourceMarkerSize,
    height: sourceMarkerSize,
    borderRadius: sourceMarkerSize / 2,
    borderWidth: 3,
  },
  estimatedSource: {
    position: 'absolute',
    width: sourceMarkerSize,
    height: sourceMarkerSize,
    alignItems: 'center',
    justifyContent: 'center',
  },
  estimatedSourceGlyph: { color: sourceColor, fontSize: 20, fontWeight: '800', lineHeight: 22 },
  cornerLabel: { position: 'absolute', fontSize: 10 },
  bottomLeft: { left: 4, bottom: 2 },
  topRight: { right: 4, top: 2 },
});
