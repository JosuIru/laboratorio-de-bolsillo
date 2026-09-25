import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { constellationShortLabels } from '@/processing/gnss/constellations';
import { sortForCarrierToNoiseBars } from '@/processing/gnss/skyStatistics';
import type { SatelliteObservation } from '@/processing/gnss/types';
import { useThemePalette } from '@/ui/theme';

import { constellationColors } from './constellationColors';

const barAreaHeight = 110;
/** Escala de las barras (dB-Hz): los móviles rara vez pasan de 50. */
const maximumBarDbHz = 50;

/**
 * Barras de C/N0 por señal. Color por constelación, opacas si la señal se usa en la posición.
 * Debajo, el número del satélite y la banda si no es la principal.
 */
export function CarrierToNoiseBars({
  observations,
  accessibilityLabel,
}: {
  observations: readonly SatelliteObservation[];
  accessibilityLabel: string;
}) {
  const themePalette = useThemePalette();
  const sortedObservations = sortForCarrierToNoiseBars(observations);

  return (
    <ScrollView horizontal accessibilityLabel={accessibilityLabel} contentContainerStyle={styles.barRow}>
      {sortedObservations.map((observation) => {
        const barHeight =
          (Math.min(maximumBarDbHz, observation.carrierToNoiseDensityDbHz) / maximumBarDbHz) * barAreaHeight;
        const isSecondaryBand = observation.bandId !== 'L1' && observation.bandId !== 'G1';
        return (
          <View
            key={`${observation.constellationId}-${observation.svid}-${observation.bandId}`}
            style={styles.barColumn}
            accessible
            accessibilityLabel={`${constellationShortLabels[observation.constellationId]} ${observation.svid} ${observation.bandId}: ${Math.round(observation.carrierToNoiseDensityDbHz)} dB-Hz`}>
            <Text style={[styles.valueLabel, { color: themePalette.textSecondary }]}>
              {Math.round(observation.carrierToNoiseDensityDbHz)}
            </Text>
            <View style={[styles.barTrack, { height: barAreaHeight }]}>
              <View
                style={{
                  height: barHeight,
                  backgroundColor: constellationColors[observation.constellationId],
                  opacity: observation.isUsedInFix ? 1 : 0.4,
                  borderTopLeftRadius: 3,
                  borderTopRightRadius: 3,
                }}
              />
            </View>
            <Text style={[styles.svidLabel, { color: themePalette.textPrimary }]}>{observation.svid}</Text>
            <Text style={[styles.bandLabel, { color: isSecondaryBand ? themePalette.accent : themePalette.textSecondary }]}>
              {observation.bandId}
            </Text>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  barRow: { gap: 4, paddingVertical: 4, alignItems: 'flex-end' },
  barColumn: { width: 22, alignItems: 'stretch' },
  barTrack: { justifyContent: 'flex-end' },
  valueLabel: { fontSize: 9, textAlign: 'center', fontVariant: ['tabular-nums'] },
  svidLabel: { fontSize: 10, textAlign: 'center', fontVariant: ['tabular-nums'] },
  bandLabel: { fontSize: 8, textAlign: 'center' },
});
