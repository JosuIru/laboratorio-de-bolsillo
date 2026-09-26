import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Alert,
  Animated,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  Linking,
  Modal,
  type NativeTouchEvent,
  PanResponder,
  type PanResponderGestureState,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { saveImageToGallery } from '@/core/export/saveToGallery';
import { shareAttachment } from '@/core/export/shareMeasurements';
import type { Attachment } from '@/core/measurements/types';

import {
  computeDoubleTapTransform,
  computePinchTransform,
  clampTranslation,
  detectSwipe,
  distanceBetween,
  identityTransform,
  midpointBetween,
  minimumZoomScale,
  nextImageIndex,
  type Point,
  type ViewportSize,
  type ViewTransform,
} from './imageViewerGeometry';

export interface ImageViewerItem {
  attachment: Attachment;
  /** Texto bajo la imagen: instrumento y fecha. */
  caption: string;
}

interface ImageViewerProps {
  images: readonly ImageViewerItem[];
  /** `null`: visor cerrado. */
  openedIndex: number | null;
  onClose(): void;
  /** Para cargar más imágenes cuando el usuario se acerca al final de la lista. */
  onIndexChange?(currentIndex: number): void;
}

const doubleTapIntervalMs = 280;
const tapMovementTolerance = 8;
const overlayTextColor = '#FFFFFF';

interface GestureBaseline {
  transform: ViewTransform;
  touchCount: number;
  horizontalOffset: number;
  verticalOffset: number;
  pinchStartDistance: number;
  pinchStartFocalPoint: Point;
  hasPinched: boolean;
  hasMoved: boolean;
}

function touchPoint(touch: NativeTouchEvent): Point {
  return { x: touch.pageX, y: touch.pageY };
}

/** Visor a pantalla completa: pellizco para ampliar, arrastre, doble toque y deslizar para pasar de imagen. */
export function ImageViewer({ images, openedIndex, onClose, onIndexChange }: ImageViewerProps) {
  const isVisible = openedIndex !== null && images.length > 0;
  return (
    <Modal
      visible={isVisible}
      animationType="fade"
      transparent={false}
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}>
      {isVisible ? (
        <ImageViewerContent
          images={images}
          initialIndex={Math.min(openedIndex, images.length - 1)}
          onClose={onClose}
          onIndexChange={onIndexChange}
        />
      ) : null}
    </Modal>
  );
}

function ImageViewerContent({
  images,
  initialIndex,
  onClose,
  onIndexChange,
}: {
  images: readonly ImageViewerItem[];
  initialIndex: number;
  onClose(): void;
  onIndexChange?(currentIndex: number): void;
}) {
  const { t } = useTranslation();
  const safeAreaInsets = useSafeAreaInsets();
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [areControlsVisible, setAreControlsVisible] = useState(true);
  const [failedImageUris, setFailedImageUris] = useState<ReadonlySet<string>>(new Set());
  const [isSavingToGallery, setIsSavingToGallery] = useState(false);

  const scaleValue = useRef(new Animated.Value(1)).current;
  const translateXValue = useRef(new Animated.Value(0)).current;
  const translateYValue = useRef(new Animated.Value(0)).current;
  const currentTransformRef = useRef<ViewTransform>(identityTransform);
  const viewportRef = useRef<ViewportSize>({ width: 1, height: 1 });
  const gestureBaselineRef = useRef<GestureBaseline | null>(null);
  const lastTapRef = useRef<{ tapTime: number; tapPoint: Point } | null>(null);
  const singleTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // El PanResponder se crea una vez: lee el índice y el número de imágenes a través de refs.
  const currentIndexRef = useRef(currentIndex);
  const imageCountRef = useRef(images.length);
  useEffect(() => {
    currentIndexRef.current = currentIndex;
    imageCountRef.current = images.length;
  }, [currentIndex, images.length]);

  const safeIndex = Math.min(currentIndex, images.length - 1);
  const currentImage = images[safeIndex];

  useEffect(() => {
    onIndexChange?.(safeIndex);
  }, [safeIndex, onIndexChange]);

  useEffect(
    () => () => {
      if (singleTapTimerRef.current) clearTimeout(singleTapTimerRef.current);
    },
    [],
  );

  const panResponder = useMemo(() => {
    function applyTransform(nextTransform: ViewTransform, isAnimated: boolean) {
      currentTransformRef.current = nextTransform;
      if (!isAnimated) {
        scaleValue.setValue(nextTransform.scale);
        translateXValue.setValue(nextTransform.translation.x);
        translateYValue.setValue(nextTransform.translation.y);
        return;
      }
      const springOptions = { useNativeDriver: true, bounciness: 0, speed: 20 } as const;
      Animated.parallel([
        Animated.spring(scaleValue, { ...springOptions, toValue: nextTransform.scale }),
        Animated.spring(translateXValue, { ...springOptions, toValue: nextTransform.translation.x }),
        Animated.spring(translateYValue, { ...springOptions, toValue: nextTransform.translation.y }),
      ]).start();
    }

    function startBaseline(touches: NativeTouchEvent[], gestureState: PanResponderGestureState, previous?: GestureBaseline) {
      const [firstTouch, secondTouch] = touches;
      const isPinch = firstTouch !== undefined && secondTouch !== undefined;
      gestureBaselineRef.current = {
        transform: currentTransformRef.current,
        touchCount: touches.length,
        horizontalOffset: gestureState.dx,
        verticalOffset: gestureState.dy,
        pinchStartDistance: isPinch ? distanceBetween(touchPoint(firstTouch), touchPoint(secondTouch)) : 0,
        pinchStartFocalPoint: isPinch ? midpointBetween(touchPoint(firstTouch), touchPoint(secondTouch)) : { x: 0, y: 0 },
        hasPinched: (previous?.hasPinched ?? false) || isPinch,
        hasMoved: (previous?.hasMoved ?? false) || isPinch,
      };
    }

    function handleTap(tapPoint: Point) {
      const now = Date.now();
      const previousTap = lastTapRef.current;
      const isDoubleTap =
        previousTap !== null &&
        now - previousTap.tapTime < doubleTapIntervalMs &&
        distanceBetween(previousTap.tapPoint, tapPoint) < 40;
      if (isDoubleTap) {
        lastTapRef.current = null;
        if (singleTapTimerRef.current) clearTimeout(singleTapTimerRef.current);
        applyTransform(computeDoubleTapTransform(currentTransformRef.current, tapPoint, viewportRef.current), true);
        return;
      }
      lastTapRef.current = { tapTime: now, tapPoint };
      // Un toque suelto muestra u oculta los controles, salvo que llegue el segundo toque.
      singleTapTimerRef.current = setTimeout(() => {
        setAreControlsVisible((wereVisible) => !wereVisible);
      }, doubleTapIntervalMs);
    }

    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event: GestureResponderEvent, gestureState) => {
        startBaseline(event.nativeEvent.touches, gestureState);
      },
      onPanResponderMove: (event: GestureResponderEvent, gestureState) => {
        const touches = event.nativeEvent.touches;
        let baseline = gestureBaselineRef.current;
        if (!baseline || baseline.touchCount !== touches.length) {
          // Al poner o quitar un dedo se toma la posición actual como nuevo punto de partida.
          startBaseline(touches, gestureState, baseline ?? undefined);
          baseline = gestureBaselineRef.current!;
        }
        const horizontalDistance = gestureState.dx - baseline.horizontalOffset;
        const verticalDistance = gestureState.dy - baseline.verticalOffset;
        if (Math.hypot(gestureState.dx, gestureState.dy) > tapMovementTolerance) baseline.hasMoved = true;

        const [firstTouch, secondTouch] = touches;
        if (firstTouch && secondTouch) {
          applyTransform(
            computePinchTransform({
              startTransform: baseline.transform,
              startDistance: baseline.pinchStartDistance,
              startFocalPoint: baseline.pinchStartFocalPoint,
              currentDistance: distanceBetween(touchPoint(firstTouch), touchPoint(secondTouch)),
              currentFocalPoint: midpointBetween(touchPoint(firstTouch), touchPoint(secondTouch)),
              viewport: viewportRef.current,
            }),
            false,
          );
          return;
        }
        if (baseline.transform.scale > minimumZoomScale + 0.01) {
          const draggedTranslation = {
            x: baseline.transform.translation.x + horizontalDistance,
            y: baseline.transform.translation.y + verticalDistance,
          };
          applyTransform(
            {
              scale: baseline.transform.scale,
              translation: clampTranslation(draggedTranslation, baseline.transform.scale, viewportRef.current),
            },
            false,
          );
          return;
        }
        if (!baseline.hasPinched) {
          // Sin zoom, la imagen acompaña al dedo en horizontal para anticipar el cambio de imagen.
          translateXValue.setValue(horizontalDistance);
        }
      },
      onPanResponderRelease: (_event, gestureState) => {
        const baseline = gestureBaselineRef.current;
        gestureBaselineRef.current = null;
        if (!baseline?.hasMoved) {
          handleTap({ x: gestureState.x0, y: gestureState.y0 });
          return;
        }
        const isZoomed = currentTransformRef.current.scale > minimumZoomScale + 0.01;
        if (isZoomed) return;
        const swipeDirection = baseline.hasPinched
          ? 'none'
          : detectSwipe(gestureState.dx, gestureState.dy, gestureState.vx, viewportRef.current.width);
        const targetIndex = nextImageIndex(currentIndexRef.current, swipeDirection, imageCountRef.current);
        if (targetIndex !== currentIndexRef.current) {
          applyTransform(identityTransform, false);
          setCurrentIndex(targetIndex);
        } else {
          applyTransform(identityTransform, true);
        }
      },
      onPanResponderTerminate: () => {
        gestureBaselineRef.current = null;
        applyTransform(identityTransform, true);
      },
    });
  }, [scaleValue, translateXValue, translateYValue]);

  function resetTransform() {
    currentTransformRef.current = identityTransform;
    scaleValue.setValue(1);
    translateXValue.setValue(0);
    translateYValue.setValue(0);
  }

  function goToIndex(targetIndex: number) {
    if (targetIndex < 0 || targetIndex >= images.length || targetIndex === safeIndex) return;
    resetTransform();
    setCurrentIndex(targetIndex);
  }

  function handleLayout(layoutEvent: LayoutChangeEvent) {
    const { width, height } = layoutEvent.nativeEvent.layout;
    viewportRef.current = { width: Math.max(1, width), height: Math.max(1, height) };
  }

  async function handleSaveToGallery() {
    if (!currentImage) return;
    setIsSavingToGallery(true);
    try {
      const saveResult = await saveImageToGallery(currentImage.attachment.fileUri);
      if (saveResult.status === 'saved') {
        Alert.alert(
          t('imageViewer.savedTitle'),
          saveResult.isInAlbum ? t('imageViewer.savedInAlbum') : t('imageViewer.savedInGallery'),
        );
      } else if (saveResult.status === 'permission-denied') {
        Alert.alert(t('imageViewer.permissionDeniedTitle'), t('imageViewer.permissionDeniedMessage'), [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('common.retry'), onPress: () => void handleSaveToGallery() },
        ]);
      } else {
        Alert.alert(t('imageViewer.permissionDeniedTitle'), t('imageViewer.permissionBlockedMessage'), [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('instrument.openSystemSettings'), onPress: () => void Linking.openSettings() },
        ]);
      }
    } catch (saveError) {
      Alert.alert(t('common.error', { message: String(saveError) }));
    } finally {
      setIsSavingToGallery(false);
    }
  }

  function handleShare() {
    if (!currentImage) return;
    shareAttachment(currentImage.attachment, t('imageViewer.share')).catch((shareError: unknown) =>
      Alert.alert(t('common.error', { message: String(shareError) })),
    );
  }

  if (!currentImage) return null;
  const imageUri = currentImage.attachment.fileUri;
  const hasFailedToLoad = failedImageUris.has(imageUri);

  return (
    <View style={styles.viewerBackground}>
      <StatusBar hidden style="light" />
      <View style={styles.imageArea} onLayout={handleLayout} {...panResponder.panHandlers}>
        {hasFailedToLoad ? (
          <Text style={styles.messageText}>{t('imageViewer.loadError')}</Text>
        ) : (
          <Animated.Image
            key={imageUri}
            source={{ uri: imageUri }}
            resizeMode="contain"
            accessibilityLabel={currentImage.caption}
            onError={() => setFailedImageUris((previousUris) => new Set(previousUris).add(imageUri))}
            style={[
              styles.fullImage,
              { transform: [{ translateX: translateXValue }, { translateY: translateYValue }, { scale: scaleValue }] },
            ]}
          />
        )}
      </View>

      {areControlsVisible ? (
        <>
          <View style={[styles.topBar, { paddingTop: safeAreaInsets.top + 8 }]} pointerEvents="box-none">
            <Text style={styles.counterText}>
              {t('imageViewer.counter', { current: safeIndex + 1, total: images.length })}
            </Text>
            <ViewerButton label={t('imageViewer.close')} glyph="✕" onPress={onClose} />
          </View>

          <View style={[styles.bottomBar, { paddingBottom: safeAreaInsets.bottom + 12 }]}>
            <Text style={styles.captionText} numberOfLines={2}>
              {currentImage.caption}
            </Text>
            <View style={styles.actionRow}>
              <ViewerButton
                label={t('imageViewer.previous')}
                glyph="‹"
                isDisabled={safeIndex === 0}
                onPress={() => goToIndex(safeIndex - 1)}
              />
              <ViewerButton
                label={t('imageViewer.saveToGallery')}
                isBusy={isSavingToGallery}
                isDisabled={hasFailedToLoad}
                onPress={() => void handleSaveToGallery()}
              />
              <ViewerButton label={t('imageViewer.share')} isDisabled={hasFailedToLoad} onPress={handleShare} />
              <ViewerButton
                label={t('imageViewer.next')}
                glyph="›"
                isDisabled={safeIndex >= images.length - 1}
                onPress={() => goToIndex(safeIndex + 1)}
              />
            </View>
          </View>
        </>
      ) : null}
    </View>
  );
}

/** Botón claro sobre fondo negro. Con `glyph`, muestra solo el símbolo y usa `label` para accesibilidad. */
function ViewerButton({
  label,
  glyph,
  onPress,
  isDisabled = false,
  isBusy = false,
}: {
  label: string;
  glyph?: string;
  onPress(): void;
  isDisabled?: boolean;
  isBusy?: boolean;
}) {
  const isInactive = isDisabled || isBusy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: isInactive, busy: isBusy }}
      disabled={isInactive}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [
        glyph ? styles.glyphButton : styles.textButton,
        { opacity: isInactive ? 0.35 : pressed ? 0.6 : 1 },
      ]}>
      {isBusy ? (
        <ActivityIndicator color={overlayTextColor} />
      ) : (
        <Text style={glyph ? styles.glyphText : styles.buttonText}>{glyph ?? label}</Text>
      )}
    </Pressable>
  );
}

const overlayBackground = 'rgba(0, 0, 0, 0.55)';

const styles = StyleSheet.create({
  viewerBackground: { flex: 1, backgroundColor: '#000000' },
  imageArea: { flex: 1, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  fullImage: { width: '100%', height: '100%' },
  messageText: { color: overlayTextColor, fontSize: 15, padding: 24, textAlign: 'center' },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 8,
    backgroundColor: overlayBackground,
  },
  counterText: { color: overlayTextColor, fontSize: 15, fontWeight: '600' },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 12,
    paddingTop: 10,
    gap: 10,
    backgroundColor: overlayBackground,
  },
  captionText: { color: overlayTextColor, fontSize: 14, textAlign: 'center' },
  actionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  glyphButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  glyphText: { color: overlayTextColor, fontSize: 30, lineHeight: 34 },
  textButton: {
    flexShrink: 1,
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: overlayTextColor,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { color: overlayTextColor, fontSize: 14, fontWeight: '600', textAlign: 'center' },
});
