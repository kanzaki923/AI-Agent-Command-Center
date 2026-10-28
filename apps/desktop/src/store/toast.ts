import { create } from 'zustand';
import { type UserFacingError, describeError } from '../daemon/errors';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  title: string;
  detail?: string;
  tone: 'info' | 'success' | 'error';
  /** Errors and decisions stay until dismissed (§8.5). */
  sticky: boolean;
  action?: ToastAction;
  /** Merge key: a second toast with the same key replaces the first. */
  key?: string;
}

interface ToastState {
  toasts: Toast[];
  push: (t: Omit<Toast, 'id'> & { durationMs?: number }) => number;
  dismiss: (id: number) => void;
  pause: (id: number) => void;
  resume: (id: number) => void;
}

let nextId = 1;
const timers = new Map<number, { timer: ReturnType<typeof setTimeout> | null; ms: number }>();

export const useToasts = create<ToastState>((set, get) => {
  const arm = (id: number, ms: number) => {
    const timer = setTimeout(() => get().dismiss(id), ms);
    timers.set(id, { timer, ms });
  };
  return {
    toasts: [],
    push(t) {
      const id = nextId++;
      const { durationMs, ...rest } = t;
      set((s) => ({
        toasts: [...s.toasts.filter((x) => !(t.key && x.key === t.key)), { ...rest, id }],
      }));
      if (!t.sticky) arm(id, durationMs ?? (t.action ? 5000 : 4000));
      return id;
    },
    dismiss(id) {
      const t = timers.get(id);
      if (t?.timer) clearTimeout(t.timer);
      timers.delete(id);
      set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
    },
    pause(id) {
      const t = timers.get(id);
      if (t?.timer) {
        clearTimeout(t.timer);
        t.timer = null;
      }
    },
    resume(id) {
      const t = timers.get(id);
      if (t && !t.timer) arm(id, Math.min(t.ms, 2500));
    },
  };
});

export function toast(t: Omit<Toast, 'id'> & { durationMs?: number }): number {
  return useToasts.getState().push(t);
}

/** Show an API/client error as a toast with the §8.4 wording. */
export function toastError(err: unknown, prefix?: string): UserFacingError {
  const d = describeError(err);
  toast({
    title: prefix ? `${prefix}: ${d.title}` : d.title,
    detail: d.detail,
    tone: d.tone === 'info' ? 'info' : 'error',
    sticky: d.sticky,
    ...(d.sticky
      ? {
          action: {
            label: '詳細をコピー',
            run: () => void navigator.clipboard?.writeText(d.detail).catch(() => {}),
          },
        }
      : {}),
  });
  return d;
}
