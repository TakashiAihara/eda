/**
 * A key press as the key sheet writes it: `Ctrl+=`, `Shift+Enter`, `?`.
 *
 * Shift is named only for keys without a character of their own. `?` and `+` already carry
 * it, and naming it there would make the same key read differently across keyboard layouts.
 */
export function combo(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): string {
  const key = e.key === ' ' ? 'Space' : e.key;
  return `${e.ctrlKey || e.metaKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey && key.length > 1 ? 'Shift+' : ''}${key}`;
}

const arrows: Record<string, string> = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' };

/** How a combo is shown to a person. */
export const show = (c: string): string => c.replace(/Arrow(Left|Right|Up|Down)/, (a) => arrows[a]!);
