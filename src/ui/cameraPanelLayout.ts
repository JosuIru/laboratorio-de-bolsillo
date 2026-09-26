/**
 * Lógica pura del panel inferior de la cámara a pantalla completa (sin React ni React Native):
 * alturas visibles de cada estado, desplazamiento del panel y a qué estado se ajusta tras arrastrarlo.
 */

/** Oculto (solo el asa) / asomado (una fila de acciones principales) / abierto (ajustes y resultados). */
export type CameraPanelState = 'hidden' | 'peek' | 'open';

export const cameraPanelStatesInOrder: readonly CameraPanelState[] = ['hidden', 'peek', 'open'];

/** Alto de la zona del asa, que se ve siempre para poder volver a sacar el panel. */
export const panelHandleHeight = 32;
/** Alto de la fila de acciones principales cuando el panel asoma. */
export const panelPrimaryActionsHeight = 64;
/** Alto de la barra superior translúcida (sin contar la zona segura). */
export const topBarHeight = 56;
/** Fracción máxima de la pantalla que ocupa el panel abierto. */
const openPanelScreenFraction = 0.6;
/** Hueco que el panel abierto deja siempre bajo la barra superior para ver algo de imagen. */
const minimumImageGapAboveOpenPanel = 48;

export interface CameraPanelMetrics {
  /** Alto visible (en px) del panel en cada estado, contando la zona segura inferior. */
  visibleHeightByState: Record<CameraPanelState, number>;
  /** Alto total del panel: el del estado abierto. El resto de estados lo desplazan hacia abajo. */
  totalPanelHeight: number;
}

export function computeCameraPanelMetrics({
  screenHeight,
  topInset,
  bottomInset,
  hasPrimaryActions,
}: {
  screenHeight: number;
  topInset: number;
  bottomInset: number;
  hasPrimaryActions: boolean;
}): CameraPanelMetrics {
  const hiddenHeight = panelHandleHeight + bottomInset;
  const peekHeight = hasPrimaryActions ? hiddenHeight + panelPrimaryActionsHeight : hiddenHeight;
  const maximumOpenHeight = screenHeight - topInset - topBarHeight - minimumImageGapAboveOpenPanel;
  const openHeight = Math.max(peekHeight, Math.min(screenHeight * openPanelScreenFraction, maximumOpenHeight));
  return {
    visibleHeightByState: { hidden: hiddenHeight, peek: peekHeight, open: openHeight },
    totalPanelHeight: openHeight,
  };
}

/** Desplazamiento vertical (translateY) del panel para que asome justo lo de ese estado. */
export function panelTranslationForState(panelState: CameraPanelState, panelMetrics: CameraPanelMetrics): number {
  return panelMetrics.totalPanelHeight - panelMetrics.visibleHeightByState[panelState];
}

/** Desplazamiento durante el arrastre, sin salirse de los límites (ni más arriba que abierto ni más abajo que oculto). */
export function clampPanelTranslation(requestedTranslation: number, panelMetrics: CameraPanelMetrics): number {
  const maximumTranslation = panelTranslationForState('hidden', panelMetrics);
  return Math.min(maximumTranslation, Math.max(0, requestedTranslation));
}

/** Tiempo (ms) que se proyecta el movimiento con la velocidad del dedo al soltar: un gesto rápido llega más lejos. */
const releaseProjectionMilliseconds = 150;

/**
 * Estado al que se ajusta el panel al soltarlo: el más cercano a donde habría llegado siguiendo
 * la inercia del dedo. `velocityY` en px/ms, positiva hacia abajo (como en PanResponder).
 */
export function snapPanelStateAfterDrag({
  releasedTranslation,
  velocityY,
  panelMetrics,
}: {
  releasedTranslation: number;
  velocityY: number;
  panelMetrics: CameraPanelMetrics;
}): CameraPanelState {
  const projectedTranslation = clampPanelTranslation(
    releasedTranslation + velocityY * releaseProjectionMilliseconds,
    panelMetrics,
  );
  let nearestState: CameraPanelState = 'hidden';
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const candidateState of cameraPanelStatesInOrder) {
    const candidateDistance = Math.abs(panelTranslationForState(candidateState, panelMetrics) - projectedTranslation);
    if (candidateDistance < nearestDistance) {
      nearestDistance = candidateDistance;
      nearestState = candidateState;
    }
  }
  return nearestState;
}

/** Toque en el asa: de oculto asoma, de asomado se abre y de abierto vuelve a asomar. */
export function nextPanelStateOnHandlePress(panelState: CameraPanelState): CameraPanelState {
  return panelState === 'peek' ? 'open' : 'peek';
}

/** Un paso más abierto (acción «incrementar» de accesibilidad). */
export function expandPanelState(panelState: CameraPanelState): CameraPanelState {
  return panelState === 'hidden' ? 'peek' : 'open';
}

/** Un paso más plegado (acción «decrementar» de accesibilidad). */
export function collapsePanelState(panelState: CameraPanelState): CameraPanelState {
  return panelState === 'open' ? 'peek' : 'hidden';
}
