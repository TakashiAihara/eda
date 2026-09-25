import { expect, test } from 'bun:test';
import { combo, show } from '../web/keys.ts';

const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  combo({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

test('named keys carry Shift, characters do not', () => {
  expect(k('Enter', { shiftKey: true })).toBe('Shift+Enter');
  expect(k('F6', { shiftKey: true })).toBe('Shift+F6');
  expect(k('?', { shiftKey: true })).toBe('?');
  expect(k('+', { shiftKey: true })).toBe('+');
});

test('Cmd counts as Ctrl, Alt is kept, Space is named', () => {
  expect(k('=', { metaKey: true })).toBe('Ctrl+=');
  expect(k('-', { ctrlKey: true })).toBe('Ctrl+-');
  expect(k('Tab', { altKey: true })).toBe('Alt+Tab');
  expect(k(' ')).toBe('Space');
});

test('arrows are shown as arrows', () => {
  expect(show('ArrowLeft')).toBe('←');
  expect(show('Shift+F6')).toBe('Shift+F6');
});
