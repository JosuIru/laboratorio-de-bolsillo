import { Canvas, Circle, Line, vec } from '@shopify/react-native-skia';
import { useMemo, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';

import { carrierToNoiseQuality, elevationRingRadius, projectSkyPosition } from '@/processing/gnss/skyProjection';
import { isTracked } from '@/processing/gnss/skyStatistics';
import type { SatelliteObservation } from '@/processing/gnss/types';
import { useThemePalette } from '@/ui/theme';

import { constellationColors } from './constellationColors';

interface SkyPlotProps {
  observations: readonly SatelliteObservation[];
  accessibilityLabel: string;
  cardinalLabels: { north: string; east: string; south: string; west: string };
}

interface SatelliteMarker {
  markerKey: string;
  centerX: number;
  centerY: number;
  radius: number;
  color: string;
  isTracked: boolean;
  isUsedInFix: boolean;
  isMultiBand: boolean;
}

const labelMargin = 18;
const minimumMarkerRadius = 3.5;
const maximumMarkerRadius = 9;

/**
 * Gráfico polar del cielo: centro = cénit, borde = horizonte, norte arriba. Cada punto es un
 * satélite: color por constelación, tamaño por C/N0 (la señal más fuerte de sus bandas), relleno
 * si se usa en la posición, anillo exterior si se recibe en dos bandas (L1 + L5).
 */
export function SkyPlot({ observations, accessibilityLabel, cardinalLabels }: SkyPlotProps) {
  const themePalette = useThemePalette();
  const [plotSize, setPlotSize] = useState(0);
  const plotCenter = plotSize / 2;
  const horizonRadius = Math.max(0, plotSize / 2 - labelMargin);

  const satelliteMarkers = useMemo<SatelliteMarker[]>(() => {
    const observationsBySatellite = new Map<string, SatelliteObservation[]>();
    for (const observation of observations) {
      const satelliteKey = `${observation.constellationId}-${observation.svid}`;
      observationsBySatellite.set(satelliteKey, [...(observationsBySatellite.get(satelliteKey) ?? []), observation]);
    }
    return [...observationsBySatellite].map(([satelliteKey, satelliteObservations]) => {
      const strongestObservation = satelliteObservations.reduce((strongest, candidate) =>
        candidate.carrierToNoiseDensityDbHz > strongest.carrierToNoiseDensityDbHz ? candidate : strongest,
      );
      const position = projectSkyPosition(
        strongestObservation.elevationDegrees,
        strongestObservation.azimuthDegrees,
        plotCenter,
        plotCenter,
        horizonRadius,
      );
      const signalQuality = carrierToNoiseQuality(strongestObservation.carrierToNoiseDensityDbHz);
      return {
        markerKey: satelliteKey,
        centerX: position.x,
        centerY: position.y,
        radius: minimumMarkerRadius + signalQuality * (maximumMarkerRadius - minimumMarkerRadius),
        color: constellationColors[strongestObservation.constellationId],
        isTracked: isTracked(strongestObservation),
        isUsedInFix: satelliteObservations.some((observation) => observation.isUsedInFix),
        isMultiBand: satelliteObservations.filter(isTracked).length >= 2,
      };
    });
  }, [observations, plotCenter, horizonRadius]);

  const labelStyle = [styles.cardinalLabel, { color: themePalette.textSecondary }];

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      style={styles.container}
      onLayout={(layoutEvent: LayoutChangeEvent) => {
        const { width } = layoutEvent.nativeEvent.layout;
        setPlotSize(Math.min(width, 360));
      }}>
      {plotSize > 0 ? (
        <View style={{ width: plotSize, height: plotSize }}>
          <Canvas style={{ width: plotSize, height: plotSize }}>
            {[0, 30, 60].map((ringElevation) => (
              <Circle
                key={ringElevation}
                cx={plotCenter}
                cy={plotCenter}
                r={elevationRingRadius(ringElevation, horizonRadius)}
                color={themePalette.border}
                style="stroke"
                strokeWidth={ringElevation === 0 ? 1.5 : 1}
              />
            ))}
            <Line
              p1={vec(plotCenter, plotCenter - horizonRadius)}
              p2={vec(plotCenter, plotCenter + horizonRadius)}
              color={themePalette.border}
              strokeWidth={1}
            />
            <Line
              p1={vec(plotCenter - horizonRadius, plotCenter)}
              p2={vec(plotCenter + horizonRadius, plotCenter)}
              color={themePalette.border}
              strokeWidth={1}
            />
            {satelliteMarkers.map((marker) =>
              marker.isTracked ? (
                <Circle
                  key={marker.markerKey}
                  cx={marker.centerX}
                  cy={marker.centerY}
                  r={marker.radius}
                  color={marker.color}
                  style={marker.isUsedInFix ? 'fill' : 'stroke'}
                  strokeWidth={2}
                />
              ) : (
                <Circle
                  key={marker.markerKey}
                  cx={marker.centerX}
                  cy={marker.centerY}
                  r={2}
                  color={themePalette.textSecondary}
                  opacity={0.5}
                />
              ),
            )}
            {satelliteMarkers
              .filter((marker) => marker.isMultiBand)
              .map((marker) => (
                <Circle
                  key={`${marker.markerKey}-ring`}
                  cx={marker.centerX}
                  cy={marker.centerY}
                  r={marker.radius + 3}
                  color={marker.color}
                  style="stroke"
                  strokeWidth={1.2}
                />
              ))}
          </Canvas>
          <Text style={[labelStyle, { top: 0, left: plotCenter - 8 }]}>{cardinalLabels.north}</Text>
          <Text style={[labelStyle, { bottom: 0, left: plotCenter - 8 }]}>{cardinalLabels.south}</Text>
          <Text style={[labelStyle, { top: plotCenter - 9, right: 0 }]}>{cardinalLabels.east}</Text>
          <Text style={[labelStyle, { top: plotCenter - 9, left: 0 }]}>{cardinalLabels.west}</Text>
          <Text style={[labelStyle, styles.ringLabel, { top: plotCenter - elevationRingRadius(30, horizonRadius) - 2, left: plotCenter + 3 }]}>
            30°
          </Text>
          <Text style={[labelStyle, styles.ringLabel, { top: plotCenter - elevationRingRadius(60, horizonRadius) - 2, left: plotCenter + 3 }]}>
            60°
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', width: '100%' },
  cardinalLabel: { position: 'absolute', width: 16, textAlign: 'center', fontSize: 12, fontWeight: '600' },
  ringLabel: { width: 28, textAlign: 'left', fontSize: 10, fontWeight: '400' },
});
