import { describe, expect, it, vi } from 'vitest';
import { keepOpenForToasts } from './Dialog';

function press(target: Element) {
  const preventDefault = vi.fn();
  keepOpenForToasts({ target, preventDefault });
  return preventDefault;
}

describe('<Dialog> and toasts', () => {
  it("stays open when a toast's action is pressed over it, and closes on any other press outside", () => {
    document.body.innerHTML =
      '<div data-toaster><button>元に戻す</button></div><button id="else">ほかの場所</button>';
    expect(press(document.querySelector('[data-toaster] button')!)).toHaveBeenCalled();
    expect(press(document.getElementById('else')!)).not.toHaveBeenCalled();
  });
});
