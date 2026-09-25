import { AlphaType, Canvas, ColorType, Image as SkiaImageView, type SkImage, Skia } from '@shopify/react-native-skia';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import type { AcceptedParticleEvent } from '@/processing/particles/detectionSession';
import { type RgbaImage, renderThumbnailToRgba } from '@/processing/particles/thumbnailRendering';
import { BodyText } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { muonDetectorInstrumentId } from './instrumentId';

const thumbnailDisplaySide = 88;

export function createSkiaImageFromRgba(rgbaImage: RgbaImage): SkImage | null {
  return Skia.Image.MakeImage(
    {
      width: rgbaImage.width,
      height: rgbaImage.height,
      alphaType: AlphaType.Opaque,
      colorType: ColorType.RGBA_8888,
    },
    Skia.Data.fromBytes(rgbaImage.rgbaPixels),
    rgbaImage.width * 4,
  );
}

function formatClockTime(timestampMilliseconds: number): string {
  const date = new Date(timestampMilliseconds);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((timePart) => timePart.toString().padStart(2, '0'))
    .join(':');
}

/** Galería de los últimos sucesos, del más reciente al más antiguo. */
export function ParticleGallery({ particleEvents }: { particleEvents: readonly AcceptedParticleEvent[] }) {
  const { t } = useTranslation(muonDetectorInstrumentId);
  const themePalette = useThemePalette();
  // Las imágenes de Skia se crean una sola vez por suceso.
  const [skiaImageCache] = useState(() => new Map<number, SkImage | null>());

  const galleryEntries = useMemo(() => {
    const visibleEventIds = new Set(particleEvents.map((particleEvent) => particleEvent.eventId));
    for (const cachedEventId of skiaImageCache.keys()) {
      if (!visibleEventIds.has(cachedEventId)) skiaImageCache.delete(cachedEventId);
    }
    return particleEvents.map((particleEvent) => {
      let skiaImage = skiaImageCache.get(particleEvent.eventId);
      if (skiaImage === undefined) {
        skiaImage = createSkiaImageFromRgba(renderThumbnailToRgba(particleEvent.thumbnail, thumbnailDisplaySide));
        skiaImageCache.set(particleEvent.eventId, skiaImage);
      }
      return { particleEvent, skiaImage };
    });
  }, [particleEvents, skiaImageCache]);

  if (galleryEntries.length === 0) return <BodyText tone="secondary">{t('gallery.empty')}</BodyText>;

  return (
    <View style={styles.galleryGrid}>
      {galleryEntries.map(({ particleEvent, skiaImage }) => (
        <View
          key={particleEvent.eventId}
          style={[styles.galleryTile, { borderColor: themePalette.border }]}
          accessible
          accessibilityRole="image"
          accessibilityLabel={t('gallery.eventLabel', {
            shape: t(`shapes.${particleEvent.shape}`),
            time: formatClockTime(particleEvent.detectedAtMilliseconds),
          })}>
          <View style={styles.thumbnailFrame}>
            {skiaImage ? (
              <Canvas style={styles.thumbnailCanvas}>
                <SkiaImageView
                  image={skiaImage}
                  x={0}
                  y={0}
                  width={thumbnailDisplaySide}
                  height={thumbnailDisplaySide}
                  fit="contain"
                />
              </Canvas>
            ) : null}
          </View>
          <BodyText style={styles.tileText}>{t(`shapes.${particleEvent.shape}`)}</BodyText>
          <BodyText tone="secondary" style={styles.tileText}>
            {formatClockTime(particleEvent.detectedAtMilliseconds)}
          </BodyText>
          <BodyText tone="secondary" style={styles.tileText}>
            {t('gallery.eventSize', {
              pixels: particleEvent.pixelCount,
              length: particleEvent.lengthPixels.toFixed(0),
            })}
          </BodyText>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  galleryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  galleryTile: {
    width: thumbnailDisplaySide + 12,
    padding: 6,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    gap: 2,
  },
  thumbnailFrame: {
    width: thumbnailDisplaySide,
    height: thumbnailDisplaySide,
    backgroundColor: '#000000',
    borderRadius: 4,
    overflow: 'hidden',
  },
  thumbnailCanvas: { width: thumbnailDisplaySide, height: thumbnailDisplaySide },
  tileText: { fontSize: 12, lineHeight: 16, textAlign: 'center' },
});
