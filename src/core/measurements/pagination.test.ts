import { appendPage, shouldPrefetchMore } from './pagination';

const identifyItem = (item: { id: string }) => item.id;

describe('paginación', () => {
  it('añade una página completa y deja la puerta abierta a más', () => {
    const pagedItems = appendPage([{ id: 'a' }], [{ id: 'b' }, { id: 'c' }], 2, identifyItem);
    expect(pagedItems.items.map(identifyItem)).toEqual(['a', 'b', 'c']);
    expect(pagedItems.hasMore).toBe(true);
  });

  it('una página incompleta indica que no hay más', () => {
    expect(appendPage([], [{ id: 'a' }], 2, identifyItem).hasMore).toBe(false);
    expect(appendPage([{ id: 'a' }], [], 2, identifyItem).hasMore).toBe(false);
  });

  it('no duplica elementos si el desplazamiento se ha corrido', () => {
    const pagedItems = appendPage([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }], 2, identifyItem);
    expect(pagedItems.items.map(identifyItem)).toEqual(['a', 'b', 'c']);
  });

  it('pide más cuando el visor se acerca al final', () => {
    expect(shouldPrefetchMore(5, 10, true)).toBe(false);
    expect(shouldPrefetchMore(6, 10, true)).toBe(true);
    expect(shouldPrefetchMore(9, 10, false)).toBe(false);
  });
});
