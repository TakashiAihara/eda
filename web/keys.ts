/**
 * A key press as the key sheet writes it: `Ctrl+=`, `Shift+Enter`, `?`.
 *
 * Shift is named only for keys without a character of their own. `?` and `+` already carry
 * it, and naming it there would make the same key read differently across keyboard layouts.
 */
export function combo(e: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): string {
  // Option+1 on a Mac types ¡: with Alt, a digit key is read from its position instead.
  const digit = e.altKey && e.code?.startsWith('Digit') ? e.code.slice(5) : undefined;
  // A letter is read in lower case, so CapsLock does not turn d into D.
  const key = digit ?? (e.key === ' ' ? 'Space' : /^[A-Za-z]$/.test(e.key) ? e.key.toLowerCase() : e.key);
  return `${e.ctrlKey || e.metaKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey && key.length > 1 ? 'Shift+' : ''}${key}`;
}

const arrows: Record<string, string> = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' };

/** How a combo is shown to a person. */
export const show = (c: string): string => c.replace(/Arrow(Left|Right|Up|Down)/, (a) => arrows[a]!);
