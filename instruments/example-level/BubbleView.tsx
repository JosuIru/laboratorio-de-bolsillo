import { StyleSheet, View } from 'react-native';

import type { TiltAngles } from '@/processing/signal/orientation';
import { useThemePalette } from '@/ui/theme';

const diameterPixels = 220;
const bubbleDiameterPixels = 36;
/** Inclinación con la que la burbuja toca el borde. */
const fullScaleDegrees = 10;

export function BubbleView({ tiltAngles }: { tiltAngles: TiltAngles }) {
  const themePalette = useThemePalette();
  const maxOffsetPixels = (diameterPixels - bubbleDiameterPixels) / 2;
  const clampToScale = (degrees: number) => Math.max(-1, Math.min(1, degrees / fullScaleDegrees));
  // El acelerómetro mide la reacción a la gravedad (+g hacia arriba): al bajar el borde derecho,
  // X es negativa. La burbuja se va al lado más alto; en pantalla, Y crece hacia abajo.
  let offsetXPixels = clampToScale(tiltAngles.tiltXDegrees) * maxOffsetPixels;
  let offsetYPixels = -clampToScale(tiltAngles.tiltYDegrees) * maxOffsetPixels;
  const offsetLength = Math.hypot(offsetXPixels, offsetYPixels);
  if (offsetLength > maxOffsetPixels) {
    offsetXPixels *= maxOffsetPixels / offsetLength;
    offsetYPixels *= maxOffsetPixels / offsetLength;
  }
  const isLevel = Math.hypot(tiltAngles.tiltXDegrees, tiltAngles.tiltYDegrees) < 0.5;

  return (
    <View
      accessibilityElementsHidden
      style={[styles.dial, { borderColor: themePalette.border, backgroundColor: themePalette.surface }]}>
      <View style={[styles.centerRing, { borderColor: themePalette.textSecondary }]} />
      <View
        style={[
          styles.bubble,
          {
            backgroundColor: isLevel ? themePalette.success : themePalette.accent,
            transform: [{ translateX: offsetXPixels }, { translateY: offsetYPixels }],
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  dial: {
    width: diameterPixels,
    height: diameterPixels,
    borderRadius: diameterPixels / 2,
    borderWidth: 2,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerRing: {
    position: 'absolute',
    width: bubbleDiameterPixels + 8,
    height: bubbleDiameterPixels + 8,
    borderRadius: (bubbleDiameterPixels + 8) / 2,
    borderWidth: 1,
  },
  bubble: {
    position: 'absolute',
    width: bubbleDiameterPixels,
    height: bubbleDiameterPixels,
    borderRadius: bubbleDiameterPixels / 2,
  },
});
