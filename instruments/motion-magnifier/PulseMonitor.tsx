import { Canvas, Line, Path, Skia, vec } from '@shopify/react-native-skia';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Animated, Easing, type LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';

import type { SignalTraceStore } from './signalTraceStore';

const traceColor = '#4ADE80';
const gridLineColor = 'rgba(74,222,128,0.18)';
const monitorBackgroundColor = '#06140C';
const heartColor = '#F43F5E';

/** Traza tipo monitor: verde sobre fondo oscuro, escala automática simétrica, lo nuevo a la derecha. */
function MonitorTrace({ traceStore, height }: { traceStore: SignalTraceStore; height: number }) {
  const [traceWidth, setTraceWidth] = useState(0);
  const revision = useSyncExternalStore(traceStore.subscribe, traceStore.getRevision);
  const tracePath = useMemo(() => {
    const path = Skia.Path.Make();
    const orderedValues = traceStore.readInOrder();
    if (traceWidth <= 0 || orderedValues.length < 2) return path;
    let largestMagnitude = 0;
    for (let valueIndex = 0; valueIndex < orderedValues.length; valueIndex++) {
      largestMagnitude = Math.max(largestMagnitude, Math.abs(orderedValues[valueIndex]!));
    }
    const halfRange = Math.max(1e-6, largestMagnitude * 1.15);
    // Siempre a la escala de la capacidad: la traza entra por la derecha como en un monitor.
    const horizontalStep = traceWidth / (traceStore.capacity - 1);
    const firstPointX = traceWidth - (orderedValues.length - 1) * horizontalStep;
    for (let pointIndex = 0; pointIndex < orderedValues.length; pointIndex++) {
      const pointX = firstPointX + pointIndex * horizontalStep;
      const pointY = height / 2 - (orderedValues[pointIndex]! / halfRange) * (height / 2);
      if (pointIndex === 0) path.moveTo(pointX, pointY);
      else path.lineTo(pointX, pointY);
    }
    return path;
    // `revision` indica que el búfer (mutable) tiene datos nuevos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceStore, traceWidth, height, revision]);

  return (
    <View
      style={[styles.traceArea, { height }]}
      onLayout={(layoutEvent: LayoutChangeEvent) => setTraceWidth(layoutEvent.nativeEvent.layout.width)}>
      {traceWidth > 0 ? (
        <Canvas style={{ width: traceWidth, height }}>
          {[0.25, 0.5, 0.75].map((gridFraction) => (
            <Line
              key={gridFraction}
              p1={vec(0, height * gridFraction)}
              p2={vec(traceWidth, height * gridFraction)}
              color={gridLineColor}
              strokeWidth={1}
            />
          ))}
          <Path path={tracePath} style="stroke" strokeWidth={2} strokeJoin="round" color={traceColor} />
        </Canvas>
      ) : null}
    </View>
  );
}

/**
 * Corazón que late al ritmo medido: un «golpe» corto (crece y vuelve) por cada periodo. Sin
 * medida, quieto y apagado.
 */
function BeatingHeart({ beatsPerMinute, size }: { beatsPerMinute: number | null; size: number }) {
  const [heartScale] = useState(() => new Animated.Value(1));
  // Redondeado: pequeñas variaciones de la medida no reinician la animación cada segundo.
  const roundedBeatsPerMinute = beatsPerMinute !== null ? Math.round(beatsPerMinute) : null;
  useEffect(() => {
    if (roundedBeatsPerMinute === null || roundedBeatsPerMinute <= 0) {
      heartScale.setValue(1);
      return;
    }
    const beatMilliseconds = 60000 / roundedBeatsPerMinute;
    const growMilliseconds = Math.min(110, beatMilliseconds * 0.15);
    const shrinkMilliseconds = Math.min(240, beatMilliseconds * 0.3);
    const beatLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(heartScale, {
          toValue: 1.3,
          duration: growMilliseconds,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(heartScale, {
          toValue: 1,
          duration: shrinkMilliseconds,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.delay(Math.max(0, beatMilliseconds - growMilliseconds - shrinkMilliseconds)),
      ]),
    );
    beatLoop.start();
    return () => beatLoop.stop();
  }, [roundedBeatsPerMinute, heartScale]);

  return (
    <Animated.Text
      accessible={false}
      style={[
        styles.heartGlyph,
        { fontSize: size, lineHeight: size * 1.15, opacity: beatsPerMinute !== null ? 1 : 0.35 },
        { transform: [{ scale: heartScale }] },
      ]}>
      ♥
    </Animated.Text>
  );
}

/**
 * Monitor de pulso: pulsaciones por minuto en grande, corazón que late a ese ritmo y la señal
 * filtrada de la zona de medida en vivo. `compact` es la versión de la lectura flotante.
 */
export function PulseMonitor({
  traceStore,
  beatsPerMinute,
  unitLabel,
  statusText,
  notMedicalText,
  accessibilityLabel,
  compact = false,
}: {
  traceStore: SignalTraceStore;
  beatsPerMinute: number | null;
  unitLabel: string;
  statusText: string | null;
  notMedicalText: string;
  accessibilityLabel: string;
  compact?: boolean;
}) {
  return (
    <View
      style={[styles.monitor, compact ? styles.compactMonitor : null]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}>
      <View style={styles.readingRow}>
        <BeatingHeart beatsPerMinute={beatsPerMinute} size={compact ? 26 : 38} />
        <Text style={[styles.rateText, compact ? styles.compactRateText : null]}>
          {beatsPerMinute !== null ? beatsPerMinute.toFixed(0) : '—'}
        </Text>
        <Text style={styles.unitText}>{unitLabel}</Text>
      </View>
      <MonitorTrace traceStore={traceStore} height={compact ? 44 : 72} />
      {statusText ? <Text style={styles.statusText}>{statusText}</Text> : null}
      <Text style={styles.notMedicalText}>{notMedicalText}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  monitor: {
    backgroundColor: monitorBackgroundColor,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 6,
  },
  compactMonitor: { width: 230, backgroundColor: 'transparent', paddingVertical: 0, paddingHorizontal: 0 },
  readingRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  heartGlyph: { color: heartColor, textAlign: 'center', width: 44 },
  rateText: {
    color: traceColor,
    fontSize: 48,
    lineHeight: 56,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  compactRateText: { fontSize: 34, lineHeight: 40 },
  unitText: { color: traceColor, fontSize: 16, fontWeight: '600', alignSelf: 'flex-end', marginBottom: 8 },
  traceArea: { width: '100%', overflow: 'hidden' },
  statusText: { color: '#D1FAE5', fontSize: 13 },
  notMedicalText: { color: '#FCA5A5', fontSize: 12 },
});
