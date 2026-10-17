const MODIFIER_ALIASES = new Map([
  ['ctrl', 'Control'],
  ['control', 'Control'],
  ['cmd', 'Meta'],
  ['command', 'Meta'],
  ['meta', 'Meta'],
  ['option', 'Alt'],
  ['esc', 'Escape'],
  ['return', 'Enter'],
  ['enter', 'Enter'],
  ['del', 'Delete'],
  ['backspace', 'Backspace'],
  ['tab', 'Tab'],
  ['space', 'Space'],
  ['home', 'Home'],
  ['end', 'End'],
  ['pageup', 'PageUp'],
  ['pagedown', 'PageDown'],
  ['arrowup', 'ArrowUp'],
  ['arrowdown', 'ArrowDown'],
  ['arrowleft', 'ArrowLeft'],
  ['arrowright', 'ArrowRight'],
]);

/** Normalize common agent key spellings to Playwright keyboard.press syntax. */
export function normalizeBrowserKey(key) {
  if (typeof key !== 'string') return key;
  return key.split('+').map((part) => {
    const trimmed = part.trim();
    return MODIFIER_ALIASES.get(trimmed.toLowerCase()) || trimmed;
  }).join('+');
}
