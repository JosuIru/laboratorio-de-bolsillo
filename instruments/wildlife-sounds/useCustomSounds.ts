import { useCallback, useEffect, useMemo, useState } from 'react';

import { type CustomSoundClass, type CustomSoundExample, prepareCustomClasses } from './customSounds';
import { type CustomSoundLibrary, readCustomSoundLibrary } from './customSoundStore';

const emptyLibrary: CustomSoundLibrary = { customClasses: [], examples: [] };

/**
 * Clases propias leídas de la base de datos, con sus ejemplos ya preparados para comparar (se
 * decodifican y normalizan una vez, no en cada ventana).
 */
export function useCustomSounds() {
  const [library, setLibrary] = useState<CustomSoundLibrary>(emptyLibrary);
  const [libraryErrorMessage, setLibraryErrorMessage] = useState<string | null>(null);

  const refreshLibrary = useCallback(async () => {
    try {
      setLibrary(await readCustomSoundLibrary());
      setLibraryErrorMessage(null);
    } catch (readError) {
      setLibraryErrorMessage(String(readError));
    }
  }, []);

  useEffect(() => {
    let isEffectActive = true;
    readCustomSoundLibrary()
      .then((readLibrary) => {
        if (isEffectActive) setLibrary(readLibrary);
      })
      .catch((readError: unknown) => {
        if (isEffectActive) setLibraryErrorMessage(String(readError));
      });
    return () => {
      isEffectActive = false;
    };
  }, []);

  const preparedClasses = useMemo(() => prepareCustomClasses(library.customClasses, library.examples), [library]);

  const exampleCountByClassId = useMemo(() => {
    const exampleCounts = new Map<number, number>();
    for (const example of library.examples) exampleCounts.set(example.classId, (exampleCounts.get(example.classId) ?? 0) + 1);
    return exampleCounts;
  }, [library]);

  const targetClasses: CustomSoundClass[] = useMemo(
    () => library.customClasses.filter((customClass) => !customClass.isBackground),
    [library],
  );
  const backgroundClass: CustomSoundClass | null = library.customClasses.find((customClass) => customClass.isBackground) ?? null;
  const allExamples: CustomSoundExample[] = library.examples;

  return {
    library,
    targetClasses,
    backgroundClass,
    allExamples,
    exampleCountByClassId,
    preparedClasses,
    libraryErrorMessage,
    refreshLibrary,
  };
}
