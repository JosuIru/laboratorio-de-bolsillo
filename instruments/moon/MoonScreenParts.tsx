import { Canvas, Image as SkiaImageView, type SkImage } from '@shopify/react-native-skia';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type LayoutChangeEvent, Pressable, StyleSheet, View } from 'react-native';

import type { PixelSize } from '@/core/camera/photoCropGeometry';
import { containedFrameRect } from '@/core/camera/previewGeometry';
import type { PointingGuidance } from '@/processing/astronomy/pointingGuide';
import { AppButton, BodyText } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { moonInstrumentId } from './instrumentId';
import type { LiveMoonDetection } from './useMoonFrames';

/** Por debajo de esta distancia angular la Luna ya está en el centro de la imagen. */
const centeredGuideDegrees = 4;
/** Correcciones más pequeñas no se indican (la brújula no es tan precisa). */
const negligibleCorrectionDegrees = 2;
/** Diámetro del círculo guía del ocular, como fracción del lado corto de la imagen. */
const eyepieceGuideFraction = 0.8;

interface ChipOption<TValue extends string> {
  value: TValue;
  label: string;
}

/** Fila de opciones excluyentes (como botones de radio). */
export function ChipSelector<TValue extends string>({
  options,
  selectedValue,
  onSelect,
  isDisabled = false,
}: {
  options: readonly ChipOption<TValue>[];
  selectedValue: TValue;
  onSelect(nextValue: TValue): void;
  isDisabled?: boolean;
}) {
  const themePalette = useThemePalette();
  return (
    <View style={styles.chipRow}>
      {options.map((option) => {
        const isSelected = option.value === selectedValue;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ selected: isSelected, disabled: isDisabled }}
            disabled={isDisabled}
            onPress={() => onSelect(option.value)}
            style={[styles.chip, { borderColor: isSelected ? themePalette.accent : themePalette.border }]}>
            <BodyText tone={isSelected ? 'accent' : 'secondary'}>{option.label}</BodyText>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Interruptor con aspecto de opción (activado / desactivado). */
export function ToggleChip({ label, isOn, onToggle }: { label: string; isOn: boolean; onToggle(): void }) {
  const themePalette = useThemePalette();
  return (
    <View style={styles.chipRow}>
      <Pressable
        accessibilityRole="switch"
        accessibilityState={{ checked: isOn }}
        onPress={onToggle}
        style={[styles.chip, { borderColor: isOn ? themePalette.accent : themePalette.border }]}>
        <BodyText tone={isOn ? 'accent' : 'secondary'}>{`${isOn ? '☑' : '☐'} ${label}`}</BodyText>
      </Pressable>
    </View>
  );
}

/**
 * Guía del modo telescopio: un círculo donde encajar el del ocular y un punto donde se ve la Luna.
 * La detección viene en píxeles del fotograma; la vista previa lo muestra con `contain`.
 */
export function TelescopeGuideOverlay({
  previewSize,
  liveDetection,
  isMoonOffCenter,
}: {
  previewSize: PixelSize;
  liveDetection: LiveMoonDetection | null;
  isMoonOffCenter: boolean;
}) {
  const guideDiameter = Math.min(previewSize.width, previewSize.height) * eyepieceGuideFraction;
  let moonMarker = null;
  if (liveDetection) {
    const displayedFrame = containedFrameRect({
      viewWidth: previewSize.width,
      viewHeight: previewSize.height,
      frameWidth: liveDetection.frameWidth,
      frameHeight: liveDetection.frameHeight,
    });
    const markerRadius = Math.max(10, liveDetection.radiusPixels * displayedFrame.displayScale);
    moonMarker = (
      <View
        style={[
          styles.moonMarker,
          {
            left: displayedFrame.left + liveDetection.centerX * displayedFrame.displayScale - markerRadius,
            top: displayedFrame.top + liveDetection.centerY * displayedFrame.displayScale - markerRadius,
            width: markerRadius * 2,
            height: markerRadius * 2,
            borderRadius: markerRadius,
            borderColor: isMoonOffCenter ? '#FCA5A5' : '#4ADE80',
          },
        ]}
      />
    );
  }
  return (
    <View pointerEvents="none" style={styles.guideOverlay}>
      <View
        style={[
          styles.eyepieceGuide,
          { width: guideDiameter, height: guideDiameter, borderRadius: guideDiameter / 2 },
        ]}
      />
      {moonMarker}
    </View>
  );
}

export function PointingOverlay({
  pointingGuidance,
  isBelowHorizon,
}: {
  pointingGuidance: PointingGuidance;
  isBelowHorizon: boolean;
}) {
  const { t } = useTranslation(moonInstrumentId);
  const { angularDistanceDegrees, screenArrowAngleDegrees, turnRightDegrees, raiseDegrees } = pointingGuidance;
  const isCentered = angularDistanceDegrees < centeredGuideDegrees;
  const corrections: string[] = [];
  if (Math.abs(turnRightDegrees) >= negligibleCorrectionDegrees) {
    corrections.push(t(turnRightDegrees > 0 ? 'guideTurnRight' : 'guideTurnLeft', { degrees: Math.abs(turnRightDegrees).toFixed(0) }));
  }
  if (Math.abs(raiseDegrees) >= negligibleCorrectionDegrees) {
    corrections.push(t(raiseDegrees > 0 ? 'guideRaise' : 'guideLower', { degrees: Math.abs(raiseDegrees).toFixed(0) }));
  }
  const guideMessage = isBelowHorizon
    ? t('guideBelowHorizon')
    : isCentered
      ? t('guideCentered')
      : corrections.join(' · ');
  return (
    <View pointerEvents="none" style={styles.guideOverlay}>
      {isCentered ? (
        <View style={styles.guideCenterRing} />
      ) : (
        // La flecha «➜» apunta a la derecha; RN gira en sentido horario y el ángulo es antihorario.
        <BodyText style={{ ...styles.guideArrow, transform: [{ rotate: `${-screenArrowAngleDegrees}deg` }] }}>➜</BodyText>
      )}
      {guideMessage ? (
        <View style={styles.guideLabel}>
          <BodyText style={styles.guideLabelText}>{guideMessage}</BodyText>
        </View>
      ) : null}
    </View>
  );
}

interface StepperRowProps {
  label: string;
  onDecrease(): void;
  onIncrease(): void;
  isDecreaseDisabled: boolean;
  isIncreaseDisabled: boolean;
  decreaseLabel: string;
  increaseLabel: string;
}

export function StepperRow({
  label,
  onDecrease,
  onIncrease,
  isDecreaseDisabled,
  isIncreaseDisabled,
  decreaseLabel,
  increaseLabel,
}: StepperRowProps) {
  return (
    <View style={styles.stepperRow}>
      <View style={styles.stepperButton}>
        <AppButton label={decreaseLabel} onPress={onDecrease} isDisabled={isDecreaseDisabled} variant="secondary" />
      </View>
      <BodyText style={styles.stepperLabel}>{label}</BodyText>
      <View style={styles.stepperButton}>
        <AppButton label={increaseLabel} onPress={onIncrease} isDisabled={isIncreaseDisabled} variant="secondary" />
      </View>
    </View>
  );
}

export function ResultImage({ label, skiaImage }: { label: string; skiaImage: SkImage }) {
  const [imageSide, setImageSide] = useState(0);
  return (
    <View style={styles.resultColumn}>
      <View
        style={styles.resultImageFrame}
        accessible
        accessibilityRole="image"
        accessibilityLabel={label}
        onLayout={(layoutEvent: LayoutChangeEvent) => setImageSide(layoutEvent.nativeEvent.layout.width)}>
        {imageSide > 0 ? (
          <Canvas style={{ width: imageSide, height: imageSide }}>
            <SkiaImageView image={skiaImage} x={0} y={0} width={imageSide} height={imageSide} fit="contain" />
          </Canvas>
        ) : null}
      </View>
      <BodyText tone="secondary">{label}</BodyText>
    </View>
  );
}

const styles = StyleSheet.create({
  guideOverlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  guideArrow: { fontSize: 72, lineHeight: 84, color: '#FACC15' },
  guideCenterRing: { width: 72, height: 72, borderRadius: 36, borderWidth: 3, borderColor: '#4ADE80' },
  guideLabel: {
    position: 'absolute',
    bottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  guideLabelText: { color: '#FFFFFF', fontWeight: '600' },
  eyepieceGuide: { borderWidth: 2, borderColor: 'rgba(250, 204, 21, 0.8)', borderStyle: 'dashed' },
  moonMarker: { position: 'absolute', borderWidth: 2 },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepperButton: { width: 110 },
  stepperLabel: { flex: 1, textAlign: 'center', fontWeight: '600', fontVariant: ['tabular-nums'] },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1.5 },
  resultColumn: { flex: 1, alignItems: 'center', gap: 4 },
  resultImageFrame: { width: '100%', aspectRatio: 1, backgroundColor: '#000000', borderRadius: 8, overflow: 'hidden' },
});
