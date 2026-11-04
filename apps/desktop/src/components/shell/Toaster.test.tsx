import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { toast, useToasts } from '../../store/toast';
import { Toaster } from './Toaster';

beforeEach(() => {
  useToasts.setState({ toasts: [] });
});

describe('Toaster', () => {
  it('ほか N 件 shows the folded toasts instead of throwing them away, and たたむ folds them again', async () => {
    render(<Toaster />);
    act(() => {
      toast({ title: '保存できませんでした', tone: 'error', sticky: true });
      for (const n of [1, 2, 3]) toast({ title: `お知らせ ${n}`, tone: 'info', sticky: true });
    });
    expect(screen.queryByText('保存できませんでした')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ほか 1 件' }));
    expect(screen.getByText('保存できませんでした')).toBeInTheDocument();
    expect(useToasts.getState().toasts).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: 'たたむ' }));
    await waitFor(() => expect(screen.queryByText('保存できませんでした')).toBeNull());
    expect(screen.getByRole('button', { name: 'ほか 1 件' })).toBeInTheDocument();
  });
});
