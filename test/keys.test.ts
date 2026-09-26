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
  expect(k('Enter', { altKey: true })).toBe('Alt+Enter');
  expect(k(' ')).toBe('Space');
});

test('Alt with a digit key reads the digit from the key position (Option+1 types ¡ on a Mac)', () => {
  expect(combo({ key: '¡', code: 'Digit1', ctrlKey: false, metaKey: false, altKey: true, shiftKey: false })).toBe('Alt+1');
  // Without Alt the character wins: on AZERTY the Digit1 key types & and must not act as 1.
  expect(combo({ key: '&', code: 'Digit1', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })).toBe('&');
});

test('letters are read in lower case (CapsLock)', () => {
  expect(k('D')).toBe('d');
  expect(k('f')).toBe('f');
});

test('arrows are shown as arrows', () => {
  expect(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].map(show)).toEqual(['←', '→', '↑', '↓']);
  expect(show('Shift+F6')).toBe('Shift+F6');
});
