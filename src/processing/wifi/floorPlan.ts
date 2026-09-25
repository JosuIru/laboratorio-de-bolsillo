/**
 * Plano sencillo de la casa. Todas las coordenadas están normalizadas: x e y van de 0 a 1 sobre
 * el ancho y el alto del plano. Como el plano no es cuadrado, las distancias se miden en
 * «anchos de plano» multiplicando la y por `aspectRatio` (alto / ancho).
 */

export interface PlanPoint {
  x: number;
  y: number;
}

/** Habitación rectangular. */
export interface PlanRoom {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Punto medido: dónde estaba el usuario y el RSSI promediado allí. */
export interface SignalMeasurementPoint extends PlanPoint {
  rssiDbm: number;
}

export function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Distancia entre dos puntos en anchos de plano. */
export function planDistance(firstPoint: PlanPoint, secondPoint: PlanPoint, aspectRatio: number): number {
  const horizontalDistance = firstPoint.x - secondPoint.x;
  const verticalDistance = (firstPoint.y - secondPoint.y) * aspectRatio;
  return Math.hypot(horizontalDistance, verticalDistance);
}

/** Ajusta una coordenada normalizada a la rejilla de `cellCount` celdas. */
export function snapToGrid(value: number, cellCount: number): number {
  return Math.round(clampUnit(value) * cellCount) / cellCount;
}

/**
 * Rectángulo de habitación a partir de dos esquinas arrastradas, ajustado a la rejilla.
 * Devuelve `null` si queda sin área (el usuario solo ha tocado).
 */
export function roomFromCorners(
  firstCorner: PlanPoint,
  secondCorner: PlanPoint,
  gridColumnCount: number,
  gridRowCount: number,
): PlanRoom | null {
  const left = snapToGrid(Math.min(firstCorner.x, secondCorner.x), gridColumnCount);
  const right = snapToGrid(Math.max(firstCorner.x, secondCorner.x), gridColumnCount);
  const top = snapToGrid(Math.min(firstCorner.y, secondCorner.y), gridRowCount);
  const bottom = snapToGrid(Math.max(firstCorner.y, secondCorner.y), gridRowCount);
  if (right - left <= 0 || bottom - top <= 0) return null;
  return { left, top, right, bottom };
}

export function isPointInRoom(point: PlanPoint, room: PlanRoom): boolean {
  return point.x >= room.left && point.x <= room.right && point.y >= room.top && point.y <= room.bottom;
}

/** Sin habitaciones dibujadas se considera que todo el plano es casa. */
export function isPointInsideHouse(point: PlanPoint, rooms: readonly PlanRoom[]): boolean {
  if (rooms.length === 0) return true;
  return rooms.some((room) => isPointInRoom(point, room));
}

/** Índice de la habitación más pequeña que contiene el punto (para borrarla al tocarla), o −1. */
export function findRoomIndexAt(point: PlanPoint, rooms: readonly PlanRoom[]): number {
  let selectedRoomIndex = -1;
  let selectedRoomArea = Number.POSITIVE_INFINITY;
  rooms.forEach((room, roomIndex) => {
    const roomArea = (room.right - room.left) * (room.bottom - room.top);
    if (isPointInRoom(point, room) && roomArea < selectedRoomArea) {
      selectedRoomIndex = roomIndex;
      selectedRoomArea = roomArea;
    }
  });
  return selectedRoomIndex;
}

/** Aplana las habitaciones en [left, top, right, bottom, …] para guardarlas como números. */
export function flattenRooms(rooms: readonly PlanRoom[]): number[] {
  return rooms.flatMap((room) => [room.left, room.top, room.right, room.bottom]);
}

export function unflattenRooms(flatCoordinates: readonly number[]): PlanRoom[] {
  const rooms: PlanRoom[] = [];
  for (let coordinateIndex = 0; coordinateIndex + 3 < flatCoordinates.length; coordinateIndex += 4) {
    rooms.push({
      left: flatCoordinates[coordinateIndex]!,
      top: flatCoordinates[coordinateIndex + 1]!,
      right: flatCoordinates[coordinateIndex + 2]!,
      bottom: flatCoordinates[coordinateIndex + 3]!,
    });
  }
  return rooms;
}
