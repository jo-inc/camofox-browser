import { evaluateWorldError, sourceForWorld } from '../../lib/evaluate-world.js';

describe('evaluate world', () => {
  test('main is the default and adds the mw: prefix once', () => {
    expect(sourceForWorld('document.title')).toBe('mw:document.title');
    expect(sourceForWorld('document.title', 'main')).toBe('mw:document.title');
    expect(sourceForWorld('mw:document.title')).toBe('mw:document.title');
  });

  test('isolated leaves the source as written, an explicit mw: included', () => {
    expect(sourceForWorld('document.title', 'isolated')).toBe('document.title');
    expect(sourceForWorld('mw:x', 'isolated')).toBe('mw:x');
  });

  test('only main, isolated or nothing is accepted', () => {
    expect(evaluateWorldError(undefined)).toBeNull();
    expect(evaluateWorldError('main')).toBeNull();
    expect(evaluateWorldError('isolated')).toBeNull();
    expect(evaluateWorldError('page')).toBe('world must be one of: main, isolated');
    expect(evaluateWorldError(1)).toBe('world must be one of: main, isolated');
  });
});
