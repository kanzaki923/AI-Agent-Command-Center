/**
 * The Esc ladder (ui-design §7.2): exactly one step is handled per press, top first.
 * Esc never approves, rejects, or stops an agent run.
 */
export interface EscapeContext {
  /** Palette, menu, popover or dialog open (Radix closes it itself). */
  overlayOpen: boolean;
  /** An inline editor (rename etc.) is active. */
  inlineEditing: boolean;
  /** Focus is in a text input. */
  inputFocused: boolean;
  /** The focused input is the composer of a chat that is generating. */
  composerGenerating: boolean;
  multiSelect: boolean;
  /** The detail panel is shown as an overlay (narrow window). */
  overlayPanelOpen: boolean;
  mode: 'command' | 'focus' | 'timeline';
}

export type EscapeAction =
  | 'close-overlay'
  | 'cancel-inline-edit'
  | 'stop-generation'
  | 'blur-input'
  | 'clear-selection'
  | 'close-panel'
  | 'leave-focus'
  | 'none';

export function resolveEscape(c: EscapeContext): EscapeAction {
  if (c.overlayOpen) return 'close-overlay';
  if (c.inlineEditing) return 'cancel-inline-edit';
  if (c.inputFocused && c.composerGenerating) return 'stop-generation';
  if (c.inputFocused) return 'blur-input';
  if (c.multiSelect) return 'clear-selection';
  if (c.overlayPanelOpen) return 'close-panel';
  if (c.mode === 'focus') return 'leave-focus';
  return 'none';
}
