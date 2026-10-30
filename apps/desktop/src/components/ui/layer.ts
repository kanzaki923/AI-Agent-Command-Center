import { createContext, useContext } from 'react';

/**
 * Whether a component renders inside a dialog. Popovers and menus sit at z-popover 40, below
 * dialogs (60); one opened from inside a dialog must sit above it instead, or it opens behind
 * the dialog's overlay (ui-design.md §2 z-index).
 */
export const InDialog = createContext(false);

/** z-index class of a popover or menu: above the dialog it opens from, else the popover layer. */
export function usePopoverLayer(): string {
  return useContext(InDialog) ? 'z-[61]' : 'z-[40]';
}
