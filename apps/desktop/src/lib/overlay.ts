/**
 * Whether a modal-ish layer (dialog, popover, menu, palette) is open. Single-key list
 * shortcuts and the Esc ladder yield to it. Tooltips (role=tooltip) do not count: hovering
 * a button must not swallow j / k.
 */
export function overlayOpen(doc: Document = document): boolean {
  return !!doc.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]');
}
