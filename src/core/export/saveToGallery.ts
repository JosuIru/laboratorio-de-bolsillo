import { File } from 'expo-file-system';
import { Album, Asset, requestPermissionsAsync } from 'expo-media-library';

/** Álbum de la galería donde se guardan las imágenes de las mediciones. */
export const galleryAlbumName = 'Laboratorio de Bolsillo';

export type SaveToGalleryResult =
  /** Guardada; `isInAlbum` es falso si el sistema no dejó ponerla en el álbum (queda en la galería general). */
  | { status: 'saved'; isInAlbum: boolean }
  /** El usuario ha dicho que no, pero se puede volver a preguntar. */
  | { status: 'permission-denied' }
  /** Denegado para siempre: solo se puede activar en los ajustes del sistema. */
  | { status: 'permission-blocked' };

/**
 * Guarda una imagen local (`file:///…`) en la galería, dentro del álbum de la app. Pide solo
 * permiso de escritura de fotos: la app no necesita ver la galería del usuario.
 */
export async function saveImageToGallery(imageFileUri: string): Promise<SaveToGalleryResult> {
  if (!new File(imageFileUri).exists) throw new Error('El fichero de la imagen ya no existe');

  const permissionResponse = await requestPermissionsAsync(true, ['photo']);
  if (!permissionResponse.granted) {
    return { status: permissionResponse.canAskAgain ? 'permission-denied' : 'permission-blocked' };
  }

  // Buscar el álbum puede requerir permiso de lectura (iOS o Android antiguos): si falla, se crea.
  let existingAlbum: Album | null = null;
  try {
    existingAlbum = await Album.get(galleryAlbumName);
  } catch {
    existingAlbum = null;
  }
  if (existingAlbum) {
    await Asset.create(imageFileUri, existingAlbum);
    return { status: 'saved', isInAlbum: true };
  }

  const createdAsset = await Asset.create(imageFileUri);
  try {
    await Album.create(galleryAlbumName, [createdAsset]);
    return { status: 'saved', isInAlbum: true };
  } catch {
    // Con permiso solo de escritura, iOS no deja crear álbumes: la imagen ya está en la galería.
    return { status: 'saved', isInAlbum: false };
  }
}
