/**
 * Maqueta común de los instrumentos con cámara: la vista previa normal (340 px dentro de la
 * pantalla desplazable de siempre) y un modo a pantalla completa con barra superior translúcida,
 * «lectura» flotante y panel inferior plegable.
 *
 * Diseño: la vista previa (y con ella el único `<Camera>`) ocupa SIEMPRE la misma posición del
 * árbol de React; al pasar a pantalla completa solo cambian estilos y se ocultan la cabecera de
 * Expo Router, la barra de estado y la de navegación. Un `Modal` obligaría a volver a montar la
 * cámara en otra ventana nativa (se reinicia la sesión, se pierden el enfoque fijado y el zoom, y
 * durante un instante habría dos cámaras).
 */
import { useNavigation } from 'expo-router';
import { NavigationBar } from 'expo-navigation-bar';
import { StatusBar } from 'expo-status-bar';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type AccessibilityActionEvent,
  Animated,
  BackHandler,
  type LayoutChangeEvent,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  type TextStyle,
  View,
} from 'react-native';
import { type EdgeInsets, useSafeAreaInsets } from 'react-native-safe-area-context';

import { useIsScreenActive } from '@/core/useIsScreenActive';

import {
  type CameraPanelState,
  clampPanelTranslation,
  collapsePanelState,
  computeCameraPanelMetrics,
  expandPanelState,
  nextPanelStateOnHandlePress,
  panelHandleHeight,
  panelPrimaryActionsHeight,
  panelTranslationForState,
  snapPanelStateAfterDrag,
  topBarHeight,
} from './cameraPanelLayout';
import { useThemePalette } from './theme';

/** Tamaño actual de la vista previa, para que el instrumento coloque sus superposiciones. */
export interface CameraPreviewLayout {
  previewWidth: number;
  previewHeight: number;
  isFullScreen: boolean;
}

export interface CameraScreenLayoutProps {
  /** Título de la barra superior en pantalla completa (normalmente el nombre del instrumento). */
  title: string;
  /** La vista previa con sus superposiciones (marcadores, guías, recuadros), la misma en los dos modos. */
  renderPreview(previewLayout: CameraPreviewLayout): ReactNode;
  /** Alto de la vista previa en modo normal. */
  normalPreviewHeight?: number;
  /** Contenido del modo normal por encima de la vista previa (p. ej. una introducción). */
  aboveNormalPreview?: ReactNode;
  /** Contenido del modo normal por debajo de la vista previa (ajustes, resultados…). */
  children?: ReactNode;
  /** Valor principal flotando sobre la imagen en pantalla completa. */
  readout?: ReactNode;
  /** Acciones en la barra superior en pantalla completa (linterna, girar cámara…). */
  topActions?: ReactNode;
  /** Fila de acciones principales que se ve con el panel asomado. */
  primaryActions?: ReactNode;
  /** Ajustes y resultados del panel abierto (desplazable). */
  panelContent?: ReactNode;
  /** Cada vez que cambia a un valor no nulo, el panel se abre (p. ej. al llegar un resultado). */
  panelOpenRequestKey?: string | number | null;
  onFullScreenChange?(isFullScreen: boolean): void;
}

const defaultNormalPreviewHeight = 340;
const screenPadding = 16;
const overlayBackgroundColor = 'rgba(0,0,0,0.6)';
const overlayTextColor = '#FFFFFF';

export function CameraScreenLayout({
  title,
  renderPreview,
  normalPreviewHeight = defaultNormalPreviewHeight,
  aboveNormalPreview,
  children,
  readout,
  topActions,
  primaryActions,
  panelContent,
  panelOpenRequestKey = null,
  onFullScreenChange,
}: CameraScreenLayoutProps) {
  const { t } = useTranslation();
  const themePalette = useThemePalette();
  const safeAreaInsets = useSafeAreaInsets();
  const scrollViewRef = useRef<ScrollView>(null);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });
  const [containerHeight, setContainerHeight] = useState(0);

  useFullScreenSystemChrome(isFullScreen, () => setIsFullScreen(false));

  useEffect(() => {
    onFullScreenChange?.(isFullScreen);
  }, [isFullScreen, onFullScreenChange]);

  function enterFullScreen() {
    scrollViewRef.current?.scrollTo({ y: 0, animated: false });
    setIsFullScreen(true);
  }

  function handlePreviewLayout(layoutEvent: LayoutChangeEvent) {
    const { width, height } = layoutEvent.nativeEvent.layout;
    setPreviewSize((previousSize) =>
      previousSize.width === width && previousSize.height === height ? previousSize : { width, height },
    );
  }

  const hasPanel = Boolean(primaryActions || panelContent);

  return (
    <View
      style={[styles.root, isFullScreen ? styles.fullScreenRoot : null]}
      onLayout={(layoutEvent) => setContainerHeight(layoutEvent.nativeEvent.layout.height)}>
      {isFullScreen ? <StatusBar hidden /> : null}
      <ScrollView
        ref={scrollViewRef}
        scrollEnabled={!isFullScreen}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={
          isFullScreen
            ? styles.fullScreenContent
            : [styles.normalContent, { paddingBottom: screenPadding + safeAreaInsets.bottom }]
        }>
        {isFullScreen ? null : aboveNormalPreview}
        {/* Siempre en esta misma posición del árbol: así la cámara no se vuelve a montar. */}
        <View
          style={
            isFullScreen
              ? styles.fullScreenPreview
              : [styles.normalPreview, { height: normalPreviewHeight, borderColor: themePalette.border }]
          }
          onLayout={handlePreviewLayout}>
          {renderPreview({ previewWidth: previewSize.width, previewHeight: previewSize.height, isFullScreen })}
          {isFullScreen ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('fullScreenCamera.enter')}
              hitSlop={8}
              onPress={enterFullScreen}
              style={({ pressed }) => [styles.enterFullScreenButton, { opacity: pressed ? 0.7 : 1 }]}>
              <FullScreenCornersIcon />
            </Pressable>
          )}
        </View>
        {isFullScreen ? null : children}
      </ScrollView>

      {isFullScreen ? (
        <>
          <View style={[styles.topBar, { paddingTop: safeAreaInsets.top, paddingLeft: safeAreaInsets.left + 4, paddingRight: safeAreaInsets.right + 8 }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('fullScreenCamera.exit')}
              hitSlop={4}
              onPress={() => setIsFullScreen(false)}
              style={({ pressed }) => [styles.topBarIconButton, { opacity: pressed ? 0.6 : 1 }]}>
              <Text style={styles.exitGlyph}>✕</Text>
            </Pressable>
            <Text accessibilityRole="header" numberOfLines={1} style={styles.topBarTitle}>
              {title}
            </Text>
            {topActions ? <View style={styles.topActions}>{topActions}</View> : null}
          </View>
          {readout ? (
            <View
              pointerEvents="box-none"
              style={[styles.readoutArea, { top: safeAreaInsets.top + topBarHeight + 8 }]}>
              <View pointerEvents="none" style={styles.readoutBubble}>
                {readout}
              </View>
            </View>
          ) : null}
          {hasPanel && containerHeight > 0 ? (
            <CameraBottomPanel
              containerHeight={containerHeight}
              safeAreaInsets={safeAreaInsets}
              primaryActions={primaryActions}
              panelContent={panelContent}
              panelOpenRequestKey={panelOpenRequestKey}
            />
          ) : null}
        </>
      ) : null}
    </View>
  );
}

/**
 * Mientras dura la pantalla completa: sin cabecera de Expo Router (ni gesto de volver en iOS),
 * sin barra de navegación de Android y con el botón «atrás» saliendo de pantalla completa.
 * La barra de navegación se restaura siempre: al salir, al desmontar y al pasar a segundo plano
 * (o al tapar la pantalla con otra), y se vuelve a ocultar al regresar.
 */
function useFullScreenSystemChrome(isFullScreen: boolean, exitFullScreen: () => void) {
  const navigation = useNavigation();
  const isScreenActive = useIsScreenActive();

  useLayoutEffect(() => {
    navigation.setOptions({ headerShown: !isFullScreen, gestureEnabled: !isFullScreen });
  }, [navigation, isFullScreen]);
  useEffect(
    () => () => {
      navigation.setOptions({ headerShown: true, gestureEnabled: true });
    },
    [navigation],
  );

  const shouldHideNavigationBar = isFullScreen && isScreenActive && Platform.OS === 'android';
  useEffect(() => {
    if (!shouldHideNavigationBar) return;
    NavigationBar.setHidden(true);
    return () => NavigationBar.setHidden(false);
  }, [shouldHideNavigationBar]);

  const exitFullScreenRef = useRef(exitFullScreen);
  useEffect(() => {
    exitFullScreenRef.current = exitFullScreen;
  });
  useEffect(() => {
    if (!isFullScreen) return;
    const backSubscription = BackHandler.addEventListener('hardwareBackPress', () => {
      exitFullScreenRef.current();
      return true;
    });
    return () => backSubscription.remove();
  }, [isFullScreen]);
}

function CameraBottomPanel({
  containerHeight,
  safeAreaInsets,
  primaryActions,
  panelContent,
  panelOpenRequestKey,
}: {
  containerHeight: number;
  safeAreaInsets: EdgeInsets;
  primaryActions: ReactNode;
  panelContent: ReactNode;
  panelOpenRequestKey: string | number | null;
}) {
  const { t } = useTranslation();
  const themePalette = useThemePalette();
  const hasPrimaryActions = Boolean(primaryActions);
  const panelMetrics = useMemo(
    () =>
      computeCameraPanelMetrics({
        screenHeight: containerHeight,
        topInset: safeAreaInsets.top,
        bottomInset: safeAreaInsets.bottom,
        hasPrimaryActions,
      }),
    [containerHeight, safeAreaInsets.top, safeAreaInsets.bottom, hasPrimaryActions],
  );
  const [panelState, setPanelState] = useState<CameraPanelState>(hasPrimaryActions ? 'peek' : 'hidden');
  const [panelTranslation] = useState(() => new Animated.Value(panelTranslationForState(panelState, panelMetrics)));

  // Petición del instrumento de abrir el panel (p. ej. ha llegado un resultado).
  const [handledOpenRequestKey, setHandledOpenRequestKey] = useState(panelOpenRequestKey);
  if (panelOpenRequestKey !== handledOpenRequestKey) {
    setHandledOpenRequestKey(panelOpenRequestKey);
    if (panelOpenRequestKey !== null) setPanelState('open');
  }

  useEffect(() => {
    Animated.spring(panelTranslation, {
      toValue: panelTranslationForState(panelState, panelMetrics),
      useNativeDriver: true,
      bounciness: 0,
      speed: 18,
    }).start();
  }, [panelState, panelMetrics, panelTranslation]);

  const panResponder = useMemo(() => {
    const dragStartTranslation = panelTranslationForState(panelState, panelMetrics);
    const animateToState = (targetState: CameraPanelState) =>
      Animated.spring(panelTranslation, {
        toValue: panelTranslationForState(targetState, panelMetrics),
        useNativeDriver: true,
        bounciness: 0,
        speed: 18,
      }).start();
    return PanResponder.create({
      // Un toque sigue siendo un toque del asa; solo un desplazamiento vertical claro es arrastre.
      onMoveShouldSetPanResponderCapture: (_touchEvent, gestureState) =>
        Math.abs(gestureState.dy) > 6 && Math.abs(gestureState.dy) > Math.abs(gestureState.dx),
      onPanResponderMove: (_touchEvent, gestureState) => {
        panelTranslation.setValue(clampPanelTranslation(dragStartTranslation + gestureState.dy, panelMetrics));
      },
      onPanResponderRelease: (_touchEvent, gestureState) => {
        const snappedState = snapPanelStateAfterDrag({
          releasedTranslation: clampPanelTranslation(dragStartTranslation + gestureState.dy, panelMetrics),
          velocityY: gestureState.vy,
          panelMetrics,
        });
        animateToState(snappedState);
        setPanelState(snappedState);
      },
      onPanResponderTerminate: () => animateToState(panelState),
    });
  }, [panelState, panelMetrics, panelTranslation]);

  function handleAccessibilityAction(actionEvent: AccessibilityActionEvent) {
    if (actionEvent.nativeEvent.actionName === 'increment') setPanelState(expandPanelState);
    if (actionEvent.nativeEvent.actionName === 'decrement') setPanelState(collapsePanelState);
  }

  const isPanelContentVisible = panelState === 'open';
  const arePrimaryActionsVisible = panelState !== 'hidden';

  return (
    <Animated.View
      style={[
        styles.panel,
        {
          height: panelMetrics.totalPanelHeight,
          backgroundColor: `${themePalette.surface}F2`,
          borderColor: themePalette.border,
          transform: [{ translateY: panelTranslation }],
        },
      ]}>
      <View {...panResponder.panHandlers}>
        <Pressable
          accessibilityRole="adjustable"
          accessibilityLabel={t('fullScreenCamera.panelHandle')}
          accessibilityHint={t('fullScreenCamera.panelHandleHint')}
          accessibilityValue={{ text: t(`fullScreenCamera.panelStates.${panelState}`) }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={handleAccessibilityAction}
          onPress={() => setPanelState(nextPanelStateOnHandlePress)}
          style={styles.panelHandleArea}>
          <View style={[styles.panelHandleBar, { backgroundColor: themePalette.textSecondary }]} />
        </Pressable>
      </View>
      {hasPrimaryActions ? (
        <View
          style={[styles.primaryActionsRow, { paddingLeft: safeAreaInsets.left + 12, paddingRight: safeAreaInsets.right + 12 }]}
          importantForAccessibility={arePrimaryActionsVisible ? 'auto' : 'no-hide-descendants'}
          accessibilityElementsHidden={!arePrimaryActionsVisible}>
          {primaryActions}
        </View>
      ) : null}
      {panelContent ? (
        <ScrollView
          style={styles.panelScroll}
          contentContainerStyle={[
            styles.panelScrollContent,
            { paddingBottom: screenPadding + safeAreaInsets.bottom, paddingLeft: safeAreaInsets.left + screenPadding, paddingRight: safeAreaInsets.right + screenPadding },
          ]}
          keyboardShouldPersistTaps="handled"
          importantForAccessibility={isPanelContentVisible ? 'auto' : 'no-hide-descendants'}
          accessibilityElementsHidden={!isPanelContentVisible}>
          {panelContent}
        </ScrollView>
      ) : null}
    </Animated.View>
  );
}

/** Icono ⛶ dibujado con vistas (el glifo no está en todas las fuentes de Android). */
function FullScreenCornersIcon() {
  return (
    <View style={styles.cornersIcon} pointerEvents="none">
      <View style={[styles.corner, styles.cornerTopLeft]} />
      <View style={[styles.corner, styles.cornerTopRight]} />
      <View style={[styles.corner, styles.cornerBottomLeft]} />
      <View style={[styles.corner, styles.cornerBottomRight]} />
    </View>
  );
}

/** Botón legible sobre la imagen de la cámara (fondo oscuro translúcido y texto blanco). */
export function CameraOverlayButton({
  label,
  accessibilityLabel,
  onPress,
  isDisabled = false,
  isSelected,
}: {
  label: string;
  accessibilityLabel?: string;
  onPress(): void;
  isDisabled?: boolean;
  /** Para interruptores (linterna…): se anuncia como marcado o no. */
  isSelected?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole={isSelected === undefined ? 'button' : 'switch'}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: isDisabled, ...(isSelected === undefined ? {} : { checked: isSelected }) }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.overlayButton,
        isSelected ? styles.overlayButtonSelected : null,
        { opacity: isDisabled ? 0.45 : pressed ? 0.7 : 1 },
      ]}>
      <Text style={[styles.overlayButtonLabel, isSelected ? styles.overlayButtonLabelSelected : null]}>{label}</Text>
    </Pressable>
  );
}

/** Texto blanco para la «lectura» flotante sobre la imagen. */
export function CameraOverlayText({ children, style }: { children: ReactNode; style?: TextStyle }) {
  return <Text style={[styles.overlayText, style]}>{children}</Text>;
}

const cornerSize = 7;
const cornerThickness = 2;

const styles = StyleSheet.create({
  root: { flex: 1 },
  fullScreenRoot: { backgroundColor: '#000000' },
  normalContent: { padding: screenPadding, gap: 12, flexGrow: 1 },
  fullScreenContent: { flexGrow: 1 },
  normalPreview: {
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: '#000000',
  },
  fullScreenPreview: { flex: 1, overflow: 'hidden', backgroundColor: '#000000' },
  enterFullScreenButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: overlayBackgroundColor,
  },
  cornersIcon: { width: 18, height: 18 },
  corner: { position: 'absolute', width: cornerSize, height: cornerSize, borderColor: overlayTextColor },
  cornerTopLeft: { top: 0, left: 0, borderTopWidth: cornerThickness, borderLeftWidth: cornerThickness },
  cornerTopRight: { top: 0, right: 0, borderTopWidth: cornerThickness, borderRightWidth: cornerThickness },
  cornerBottomLeft: { bottom: 0, left: 0, borderBottomWidth: cornerThickness, borderLeftWidth: cornerThickness },
  cornerBottomRight: { bottom: 0, right: 0, borderBottomWidth: cornerThickness, borderRightWidth: cornerThickness },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: overlayBackgroundColor,
  },
  topBarIconButton: { width: 48, height: topBarHeight, alignItems: 'center', justifyContent: 'center' },
  exitGlyph: { color: overlayTextColor, fontSize: 22, fontWeight: '600' },
  topBarTitle: { flex: 1, color: overlayTextColor, fontSize: 17, fontWeight: '600' },
  topActions: { flexDirection: 'row', alignItems: 'center', gap: 8, height: topBarHeight },
  readoutArea: { position: 'absolute', left: 12, right: 12, alignItems: 'flex-start' },
  readoutBubble: {
    backgroundColor: overlayBackgroundColor,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    gap: 2,
    maxWidth: '100%',
  },
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  panelHandleArea: { height: panelHandleHeight, alignItems: 'center', justifyContent: 'center' },
  panelHandleBar: { width: 44, height: 5, borderRadius: 3, opacity: 0.8 },
  primaryActionsRow: {
    height: panelPrimaryActionsHeight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  panelScroll: { flex: 1 },
  panelScrollContent: { gap: 12, paddingTop: 4 },
  overlayButton: {
    minHeight: 40,
    minWidth: 44,
    paddingHorizontal: 12,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  overlayButtonSelected: { backgroundColor: '#FFFFFF', borderColor: '#FFFFFF' },
  overlayButtonLabel: { color: overlayTextColor, fontSize: 14, fontWeight: '600' },
  overlayButtonLabelSelected: { color: '#000000' },
  overlayText: { color: overlayTextColor, fontSize: 15, lineHeight: 21 },
});
