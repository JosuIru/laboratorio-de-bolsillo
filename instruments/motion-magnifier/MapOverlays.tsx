import { Canvas, Circle, SweepGradient, vec } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { type AccessibilityActionEvent, PanResponder, StyleSheet, Text, View } from 'react-native';

import { infernoLegendColors, phaseLegendColors } from '@/processing/eulerian/motionMaps';

const overlayTextColor = '#FFFFFF';
const overlayBackgroundColor = 'rgba(0,0,0,0.6)';

const heatLegendColors = infernoLegendColors(16);
const phaseWheelColors = phaseLegendColors(13);
const phaseWheelSize = 44;
const phaseWheelStrokeWidth = 9;

/** Leyenda del mapa de calor: la escala inferno de «quieto» a «se mueve más». */
export function HeatMapLegend({ title, lowLabel, highLabel }: { title: string; lowLabel: string; highLabel: string }) {
  return (
    <View style={styles.legendBox} accessible accessibilityLabel={`${title}: ${lowLabel} → ${highLabel}`}>
      <Text style={styles.legendTitle}>{title}</Text>
      <View style={styles.heatBar}>
        {heatLegendColors.map((legendColor) => (
          <View key={legendColor} style={[styles.heatBarStep, { backgroundColor: legendColor }]} />
        ))}
      </View>
      <View style={styles.heatLabels}>
        <Text style={styles.legendText}>{lowLabel}</Text>
        <Text style={styles.legendText}>{highLabel}</Text>
      </View>
    </View>
  );
}

/**
 * Leyenda del mapa de fase: la rueda de tonos. El punto blanco marca la fase de la zona de medida
 * (la referencia, siempre roja); el tono opuesto de la rueda es la contrafase.
 */
export function PhaseMapLegend({
  title,
  sameLabel,
  oppositeLabel,
  frequencyLabel,
}: {
  title: string;
  sameLabel: string;
  oppositeLabel: string;
  frequencyLabel: string | null;
}) {
  const wheelCenter = phaseWheelSize / 2;
  const wheelRadius = wheelCenter - phaseWheelStrokeWidth / 2 - 1;
  return (
    <View
      style={styles.legendBox}
      accessible
      accessibilityLabel={[title, frequencyLabel, sameLabel, oppositeLabel].filter(Boolean).join('. ')}>
      <Text style={styles.legendTitle}>{title}</Text>
      <View style={styles.phaseRow}>
        <Canvas style={{ width: phaseWheelSize, height: phaseWheelSize }}>
          <Circle cx={wheelCenter} cy={wheelCenter} r={wheelRadius} style="stroke" strokeWidth={phaseWheelStrokeWidth}>
            <SweepGradient c={vec(wheelCenter, wheelCenter)} colors={phaseWheelColors} />
          </Circle>
          <Circle cx={wheelCenter + wheelRadius} cy={wheelCenter} r={3.5} color={overlayTextColor} />
        </Canvas>
        <View style={styles.phaseTexts}>
          {frequencyLabel ? <Text style={styles.legendText}>{frequencyLabel}</Text> : null}
          <Text style={styles.legendText}>{sameLabel}</Text>
          <Text style={styles.legendText}>{oppositeLabel}</Text>
        </View>
      </View>
    </View>
  );
}

const curtainHandleTouchWidth = 48;
const curtainKnobSize = 36;
/** Paso de la cortina con las acciones de accesibilidad (fracción del ancho). */
const curtainAccessibilityStep = 0.1;
const minimumCurtainFraction = 0.02;
const maximumCurtainFraction = 0.98;

/** Posición de la cortina tras moverla `fractionShift` (fracción del ancho), sin llegar a los bordes. */
export function shiftCurtainFraction(curtainFraction: number, fractionShift: number): number {
  return Math.min(maximumCurtainFraction, Math.max(minimumCurtainFraction, curtainFraction + fractionShift));
}

/**
 * Cortina antes/después: una línea vertical que se arrastra. A su izquierda se ve la cámara
 * original; a su derecha, lo procesado (lo recorta `MagnifiedView` con la misma posición).
 * El arrastre avisa al empezar (`onDragStart`) y luego del desplazamiento total desde ese inicio
 * (`onDragMove`): quien guarda la posición recuerda dónde empezó. Así el gesto no depende de la
 * posición actual y no se rehace a media arrastrada (los avisos deben ser estables).
 */
export function ComparisonCurtain({
  previewWidth,
  previewHeight,
  curtainFraction,
  onDragStart,
  onDragMove,
  onStep,
  leftLabel,
  rightLabel,
  accessibilityLabel,
}: {
  previewWidth: number;
  previewHeight: number;
  curtainFraction: number;
  onDragStart(): void;
  /** Desplazamiento desde el inicio del arrastre, en fracción del ancho. */
  onDragMove(fractionShiftSinceStart: number): void;
  /** Paso de accesibilidad (fracción del ancho, con signo). */
  onStep(fractionShift: number): void;
  leftLabel: string;
  rightLabel: string;
  accessibilityLabel: string;
}) {
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        // Mientras se arrastra, ni el panel ni el toque de la imagen se quedan el gesto.
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => onDragStart(),
        onPanResponderMove: (_touchEvent, gestureState) => {
          if (previewWidth > 0) onDragMove(gestureState.dx / previewWidth);
        },
      }),
    [previewWidth, onDragStart, onDragMove],
  );

  function handleAccessibilityAction(actionEvent: AccessibilityActionEvent) {
    const direction = actionEvent.nativeEvent.actionName === 'increment' ? 1 : -1;
    onStep(direction * curtainAccessibilityStep);
  }

  if (previewWidth <= 0 || previewHeight <= 0) return null;
  const curtainX = curtainFraction * previewWidth;
  return (
    <>
      <View pointerEvents="none" style={[styles.curtainLine, { left: curtainX - 1, height: previewHeight }]} />
      <View pointerEvents="none" style={[styles.curtainLabels, { top: previewHeight / 2 - curtainKnobSize / 2 - 28 }]}>
        <Text style={[styles.curtainLabel, { right: previewWidth - curtainX + 8 }]} numberOfLines={1}>
          {leftLabel}
        </Text>
        <Text style={[styles.curtainLabel, { left: curtainX + 8 }]} numberOfLines={1}>
          {rightLabel}
        </Text>
      </View>
      <View
        {...panResponder.panHandlers}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={{ min: 0, max: 100, now: Math.round(curtainFraction * 100) }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={handleAccessibilityAction}
        style={[styles.curtainHandleArea, { left: curtainX - curtainHandleTouchWidth / 2, height: previewHeight }]}>
        <View style={[styles.curtainKnob, { top: previewHeight / 2 - curtainKnobSize / 2 }]}>
          <Text style={styles.curtainKnobGlyph}>‹ ›</Text>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  legendBox: {
    backgroundColor: overlayBackgroundColor,
    borderRadius: 10,
    paddingVertical: 6,
    paddingHorizontal: 8,
    gap: 4,
    maxWidth: 220,
  },
  legendTitle: { color: overlayTextColor, fontSize: 12, fontWeight: '700' },
  legendText: { color: overlayTextColor, fontSize: 11, lineHeight: 14 },
  heatBar: { flexDirection: 'row', height: 10, width: 150, borderRadius: 3, overflow: 'hidden' },
  heatBarStep: { flex: 1 },
  heatLabels: { flexDirection: 'row', justifyContent: 'space-between', width: 150 },
  phaseRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  phaseTexts: { flexShrink: 1, gap: 2 },
  curtainLine: { position: 'absolute', top: 0, width: 2, backgroundColor: 'rgba(255,255,255,0.9)' },
  curtainLabels: { position: 'absolute', left: 0, right: 0, height: 22 },
  curtainLabel: {
    position: 'absolute',
    color: overlayTextColor,
    fontSize: 12,
    fontWeight: '700',
    backgroundColor: overlayBackgroundColor,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  curtainHandleArea: { position: 'absolute', top: 0, width: curtainHandleTouchWidth, alignItems: 'center' },
  curtainKnob: {
    position: 'absolute',
    width: curtainKnobSize,
    height: curtainKnobSize,
    borderRadius: curtainKnobSize / 2,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOpacity: 0.4,
    shadowRadius: 4,
    elevation: 4,
  },
  curtainKnobGlyph: { color: '#000000', fontSize: 16, fontWeight: '700' },
});
