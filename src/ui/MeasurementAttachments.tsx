import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Image, Pressable, StyleSheet, View } from 'react-native';

import { shareAttachment } from '@/core/export/shareMeasurements';
import { partitionAttachments } from '@/core/measurements/imageAttachments';
import type { Attachment } from '@/core/measurements/types';

import { AppButton, BodyText } from './components';
import { useThemePalette } from './theme';

export const thumbnailSize = 72;

/** Símbolo para los adjuntos que no son imágenes. */
function attachmentGlyph(attachment: Attachment): string {
  const normalizedMimeType = attachment.mimeType.toLowerCase();
  if (attachment.kind === 'audio' || normalizedMimeType.startsWith('audio/')) return '🔊';
  if (normalizedMimeType.includes('csv') || normalizedMimeType.startsWith('text/')) return '📄';
  if (normalizedMimeType.includes('json')) return '{ }';
  return '📎';
}

/** Miniatura de una imagen local. Si el fichero ya no existe, muestra un hueco con un aviso. */
export function AttachmentThumbnail({
  attachment,
  accessibilityLabel,
  onPress,
  size = thumbnailSize,
}: {
  attachment: Attachment;
  accessibilityLabel: string;
  onPress(): void;
  size?: number;
}) {
  const themePalette = useThemePalette();
  const [hasFailedToLoad, setHasFailedToLoad] = useState(false);
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [
        styles.thumbnailFrame,
        { width: size, height: size, borderColor: themePalette.border, opacity: pressed ? 0.7 : 1 },
      ]}>
      {hasFailedToLoad ? (
        <BodyText tone="secondary">?</BodyText>
      ) : (
        <Image
          source={{ uri: attachment.fileUri }}
          // En Android, «resize» decodifica la imagen al tamaño de la miniatura y ahorra memoria.
          resizeMethod="resize"
          resizeMode="cover"
          onError={() => setHasFailedToLoad(true)}
          style={{ width: size, height: size }}
        />
      )}
    </Pressable>
  );
}

/**
 * Adjuntos de una medición: las imágenes como cuadrícula de miniaturas (al tocarlas se abre el
 * visor) y el resto como botones para compartir el fichero.
 */
export function MeasurementAttachments({
  attachments,
  onOpenImage,
}: {
  attachments: readonly Attachment[];
  onOpenImage(attachment: Attachment): void;
}) {
  const { t } = useTranslation();
  const { imageAttachments, otherAttachments } = partitionAttachments(attachments);
  if (attachments.length === 0) return null;

  return (
    <View style={styles.attachmentsColumn}>
      {imageAttachments.length > 0 ? (
        <View style={styles.thumbnailGrid}>
          {imageAttachments.map((imageAttachment) => (
            <AttachmentThumbnail
              key={imageAttachment.id}
              attachment={imageAttachment}
              accessibilityLabel={t('imageViewer.openImage', { fileName: imageAttachment.fileName })}
              onPress={() => onOpenImage(imageAttachment)}
            />
          ))}
        </View>
      ) : null}
      {otherAttachments.map((otherAttachment) => (
        <AppButton
          key={otherAttachment.id}
          label={`${attachmentGlyph(otherAttachment)}  ${t('history.shareAttachment', { fileName: otherAttachment.fileName })}`}
          variant="secondary"
          onPress={() =>
            shareAttachment(otherAttachment, t('history.exportDialogTitle')).catch((shareError: unknown) =>
              Alert.alert(t('common.error', { message: String(shareError) })),
            )
          }
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  attachmentsColumn: { gap: 8 },
  thumbnailGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  thumbnailFrame: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
