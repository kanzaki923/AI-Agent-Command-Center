import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast, undoLatest, useToasts } from './toast';

describe('Ctrl+Z (undo the latest undoable action)', () => {
  beforeEach(() => useToasts.setState({ toasts: [] }));

  it('runs the newest undo action while its toast is shown, once', () => {
    const first = vi.fn();
    const second = vi.fn();
    toast({ title: 'A をアーカイブしました', tone: 'info', sticky: false, action: { label: '元に戻す', undo: true, run: first } });
    toast({ title: '情報', tone: 'info', sticky: false });
    toast({ title: 'B をアーカイブしました', tone: 'info', sticky: false, action: { label: '元に戻す', undo: true, run: second } });
    expect(undoLatest()).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(useToasts.getState().toasts.map((t) => t.title)).toEqual(['A をアーカイブしました', '情報']);
    expect(undoLatest()).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(undoLatest()).toBe(false);
  });

  it('ignores actions that are not undos', () => {
    toast({ title: 'x', tone: 'error', sticky: true, action: { label: '詳細をコピー', run: vi.fn() } });
    expect(undoLatest()).toBe(false);
  });
});
