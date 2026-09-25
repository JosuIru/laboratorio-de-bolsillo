import { useIsScreenActive } from '@/core/useIsScreenActive';

/** Cámara activa solo con la pantalla visible y la app en primer plano. */
export function useIsCameraAllowed(): boolean {
  return useIsScreenActive();
}
