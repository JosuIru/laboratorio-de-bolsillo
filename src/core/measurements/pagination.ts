/** Estado de una lista que se carga por páginas (carga perezosa al llegar al final). */
export interface PagedItems<TItem> {
  items: TItem[];
  hasMore: boolean;
}

/**
 * Añade una página a lo ya cargado sin duplicar elementos (si entre dos páginas se guarda una
 * medición, el desplazamiento se corre y la primera de la página siguiente ya estaba). Si la
 * página llega incompleta, no hay más.
 */
export function appendPage<TItem>(
  loadedItems: readonly TItem[],
  pageItems: readonly TItem[],
  pageSize: number,
  identify: (item: TItem) => string,
): PagedItems<TItem> {
  const loadedIds = new Set(loadedItems.map(identify));
  const newItems = pageItems.filter((pageItem) => !loadedIds.has(identify(pageItem)));
  return { items: [...loadedItems, ...newItems], hasMore: pageItems.length >= pageSize };
}

/** Si el visor está a `margin` elementos del final de lo cargado, conviene pedir más. */
export function shouldPrefetchMore(currentIndex: number, loadedCount: number, hasMore: boolean, margin = 3): boolean {
  return hasMore && currentIndex >= loadedCount - 1 - margin;
}
