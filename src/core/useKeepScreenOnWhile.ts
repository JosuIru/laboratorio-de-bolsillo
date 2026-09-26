import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect } from 'react';

/**
 * Mantiene la pantalla encendida mientras `isScreenNeededOn` sea verdadero. Si se apagara, la app
 * pasaría a segundo plano y el micrófono, la cámara, los sensores o el audio se pararían a mitad
 * de una medición. `keepAwakeTag` distingue a cada instrumento para no soltar el bloqueo de otro.
 */
export function useKeepScreenOnWhile(isScreenNeededOn: boolean, keepAwakeTag: string): void {
  useEffect(() => {
    if (!isScreenNeededOn) return;
    activateKeepAwakeAsync(keepAwakeTag).catch(() => undefined);
    return () => {
      deactivateKeepAwake(keepAwakeTag).catch(() => undefined);
    };
  }, [isScreenNeededOn, keepAwakeTag]);
}
