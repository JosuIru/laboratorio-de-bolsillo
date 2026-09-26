import { Canvas, Image as SkiaImageView, type SkImage } from '@shopify/react-native-skia';
import { useMemo, useState } from 'react';
import { type LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { LunarDiskView, LunarFeatureKind } from '@/processing/astronomy/lunarFeatures';
import { BodyText } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { moonInstrumentId } from './instrumentId';
import {
  type AtlasLanguage,
  chooseAtlasMarks,
  type ManualImageCorrection,
  opticsRotationOptions,
} from './moonAtlas';

/** Color de cada tipo de accidente: los lugares de alunizaje, aparte. */
const markColors: Record<LunarFeatureKind, string> = {
  mare: '#E5E7EB',
  crater: '#FACC15',
  landingSite: '#22D3EE',
};
/** Opacidad de los accidentes que ahora están de noche (al otro lado del terminador). */
const unlitOpacity = 0.4;
const dotRadius = 2.5;

interface MoonAtlasViewProps {
  skiaImage: SkImage;
  /** Lado de la imagen en píxeles (las coordenadas del atlas están en ellos). */
  imageSide: number;
  /** null: todavía no se ha encontrado el disco. */
  atlasView: LunarDiskView | null;
  language: AtlasLanguage;
}

/** La imagen resultado a todo lo ancho, con las marcas y los nombres encima. */
export function MoonAtlasView({ skiaImage, imageSide, atlasView, language }: MoonAtlasViewProps) {
  const { t } = useTranslation(moonInstrumentId);
  const [displaySide, setDisplaySide] = useState(0);
  const displayScale = imageSide > 0 ? displaySide / imageSide : 0;
  const atlasMarks = useMemo(
    () => (atlasView && displayScale > 0 ? chooseAtlasMarks(atlasView, displayScale, language) : []),
    [atlasView, displayScale, language],
  );
  return (
    <View>
      <View
        style={styles.atlasFrame}
        accessible
        accessibilityRole="image"
        accessibilityLabel={t('atlas.imageLabel')}
        onLayout={(layoutEvent: LayoutChangeEvent) => setDisplaySide(layoutEvent.nativeEvent.layout.width)}>
        {displaySide > 0 ? (
          <Canvas style={{ width: displaySide, height: displaySide }}>
            <SkiaImageView image={skiaImage} x={0} y={0} width={displaySide} height={displaySide} fit="contain" />
          </Canvas>
        ) : null}
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          {atlasMarks.map((atlasMark) => {
            const markColor = markColors[atlasMark.kind];
            const markRadius = atlasMark.markRadius > 0 ? atlasMark.markRadius : dotRadius;
            return (
              <View key={atlasMark.featureId} style={{ opacity: atlasMark.isIlluminated ? 1 : unlitOpacity }}>
                <View
                  style={[
                    styles.mark,
                    {
                      left: atlasMark.displayX - markRadius,
                      top: atlasMark.displayY - markRadius,
                      width: markRadius * 2,
                      height: markRadius * 2,
                      borderRadius: markRadius,
                      borderColor: markColor,
                      backgroundColor: atlasMark.markRadius > 0 ? 'transparent' : markColor,
                    },
                  ]}
                />
                {atlasMark.label ? (
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.markLabel,
                      { left: atlasMark.displayX + markRadius + 2, top: atlasMark.displayY - 7, color: markColor },
                    ]}>
                    {atlasMark.label}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      </View>
      {atlasView && displayScale > 0 && atlasMarks.length === 0 ? (
        <BodyText tone="secondary">{t('atlas.tooSmall')}</BodyText>
      ) : null}
    </View>
  );
}

interface AtlasControlsProps {
  correction: ManualImageCorrection;
  onChangeCorrection(nextCorrection: ManualImageCorrection): void;
  isApproximate: boolean;
  hasDisk: boolean;
}

/** Leyenda, avisos y corrección manual del giro y del espejo de la óptica. */
export function AtlasControls({ correction, onChangeCorrection, isApproximate, hasDisk }: AtlasControlsProps) {
  const { t } = useTranslation(moonInstrumentId);
  const themePalette = useThemePalette();
  return (
    <View style={styles.controls}>
      {!hasDisk ? <BodyText tone="danger">{t('atlas.diskNotFound')}</BodyText> : null}
      {/* Sobre fondo negro, como en la imagen: los colores de las marcas se ven igual. */}
      <View style={styles.legend}>
        <Text style={[styles.legendText, { color: markColors.mare }]}>● {t('atlas.legendMaria')}</Text>
        <Text style={[styles.legendText, { color: markColors.crater }]}>○ {t('atlas.legendCraters')}</Text>
        <Text style={[styles.legendText, { color: markColors.landingSite }]}>● {t('atlas.legendLandingSites')}</Text>
      </View>
      <BodyText tone="secondary">{t('atlas.unlitExplanation')}</BodyText>
      {isApproximate ? <BodyText tone="danger">{t('atlas.approximateOrientation')}</BodyText> : null}
      <BodyText tone="secondary">{t('atlas.rotationTitle')}</BodyText>
      <View style={styles.chipRow}>
        {opticsRotationOptions.map((rotationOption) => {
          const isSelected = rotationOption === correction.opticsRotationDegrees;
          return (
            <Pressable
              key={rotationOption}
              accessibilityRole="radio"
              accessibilityState={{ selected: isSelected }}
              onPress={() => onChangeCorrection({ ...correction, opticsRotationDegrees: rotationOption })}
              style={[styles.chip, { borderColor: isSelected ? themePalette.accent : themePalette.border }]}>
              <BodyText tone={isSelected ? 'accent' : 'secondary'}>{`${rotationOption}°`}</BodyText>
            </Pressable>
          );
        })}
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: correction.isMirrored }}
          onPress={() => onChangeCorrection({ ...correction, isMirrored: !correction.isMirrored })}
          style={[styles.chip, { borderColor: correction.isMirrored ? themePalette.accent : themePalette.border }]}>
          <BodyText tone={correction.isMirrored ? 'accent' : 'secondary'}>{t('atlas.mirror')}</BodyText>
        </Pressable>
      </View>
      <BodyText tone="secondary">{t('atlas.rotationHint')}</BodyText>
    </View>
  );
}

const styles = StyleSheet.create({
  atlasFrame: { width: '100%', aspectRatio: 1, backgroundColor: '#000000', borderRadius: 8, overflow: 'hidden' },
  mark: { position: 'absolute', borderWidth: 1.5 },
  markLabel: {
    position: 'absolute',
    fontSize: 11,
    fontWeight: '600',
    textShadowColor: '#000000',
    textShadowRadius: 3,
    textShadowOffset: { width: 0, height: 0 },
  },
  controls: { gap: 8 },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 16,
    rowGap: 4,
    backgroundColor: '#000000',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  legendText: { fontSize: 13, fontWeight: '600' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1.5 },
});
