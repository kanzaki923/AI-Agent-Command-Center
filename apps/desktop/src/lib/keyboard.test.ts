import { describe, expect, it } from 'vitest';
import { type EscapeContext, resolveEscape } from './escape';
import { isTypingTarget, keyParts, matchShortcut, matches } from './shortcuts';

const base: EscapeContext = {
  overlayOpen: false,
  inlineEditing: false,
  inputFocused: false,
  composerGenerating: false,
  multiSelect: false,
  overlayPanelOpen: false,
  mode: 'command',
};

describe('Esc ladder (§7.2) — exactly one step per press, top first', () => {
  it('closes overlays before anything else', () => {
    expect(resolveEscape({ ...base, overlayOpen: true, inputFocused: true, mode: 'focus' })).toBe('close-overlay');
  });
  it('cancels inline edits next', () => {
    expect(resolveEscape({ ...base, inlineEditing: true, inputFocused: true })).toBe('cancel-inline-edit');
  });
  it('stops a generating chat when the composer is focused', () => {
    expect(resolveEscape({ ...base, inputFocused: true, composerGenerating: true, mode: 'focus' })).toBe('stop-generation');
  });
  it('then leaves the input', () => {
    expect(resolveEscape({ ...base, inputFocused: true, mode: 'focus' })).toBe('blur-input');
  });
  it('then clears multi-select, then closes the overlay panel', () => {
    expect(resolveEscape({ ...base, multiSelect: true, overlayPanelOpen: true })).toBe('clear-selection');
    expect(resolveEscape({ ...base, overlayPanelOpen: true, mode: 'focus' })).toBe('close-panel');
  });
  it('finally leaves Focus Mode, and does nothing elsewhere', () => {
    expect(resolveEscape({ ...base, mode: 'focus' })).toBe('leave-focus');
    expect(resolveEscape(base)).toBe('none');
    expect(resolveEscape({ ...base, mode: 'timeline' })).toBe('none');
  });
});

const k = (key: string, mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {}) => ({
  key,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe('shortcut matching (Windows)', () => {
  it('matches modifier combos exactly', () => {
    expect(matchShortcut(k('k', { ctrlKey: true }), 'palette')).toBe(true);
    expect(matchShortcut(k('K', { ctrlKey: true }), 'palette')).toBe(true);
    expect(matchShortcut(k('k'), 'palette')).toBe(false);
    expect(matchShortcut(k('j', { ctrlKey: true }), 'nextAttention')).toBe(true);
    expect(matchShortcut(k('J', { ctrlKey: true, shiftKey: true }), 'nextAttention')).toBe(false);
    expect(matchShortcut(k('J', { ctrlKey: true, shiftKey: true }), 'prevAttention')).toBe(true);
    expect(matchShortcut(k('ArrowLeft', { altKey: true }), 'back')).toBe(true);
    expect(matchShortcut(k('Backspace', { ctrlKey: true, shiftKey: true }), 'stopRun')).toBe(true);
  });
  it('single keys require no modifiers', () => {
    expect(matchShortcut(k('j'), 'down')).toBe(true);
    expect(matchShortcut(k('j', { ctrlKey: true }), 'down')).toBe(false);
    expect(matchShortcut(k('y'), 'approve')).toBe(true);
    expect(matchShortcut(k('y', { ctrlKey: true }), 'approve')).toBe(false);
    expect(matchShortcut(k('y', { ctrlKey: true }), 'approveDanger')).toBe(true);
    expect(matchShortcut(k(' '), 'peek')).toBe(true);
  });
  it('treats ? and [ ] as shift-implied punctuation', () => {
    expect(matchShortcut(k('?', { shiftKey: true }), 'help')).toBe(true);
    expect(matches(k('[', { shiftKey: false }), '[')).toBe(true);
  });
  it('renders labels for the current OS', () => {
    expect(keyParts('Mod+Shift+J')).toEqual(['Ctrl', 'Shift', 'J']);
    expect(keyParts('Alt+ArrowLeft')).toEqual(['Alt', '←']);
  });
});

describe('isTypingTarget', () => {
  it('detects text inputs but not buttons or checkboxes', () => {
    const input = document.createElement('input');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    const ta = document.createElement('textarea');
    const btn = document.createElement('button');
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(ta)).toBe(true);
    expect(isTypingTarget(checkbox)).toBe(false);
    expect(isTypingTarget(btn)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
