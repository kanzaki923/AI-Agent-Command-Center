import { create } from 'zustand';

export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}

interface ConfirmState {
  request: ConfirmRequest | null;
  ask: (r: ConfirmRequest) => void;
  close: () => void;
}

/** Modals only for confirming irreversible/expensive actions (§8.4). */
export const useConfirm = create<ConfirmState>((set) => ({
  request: null,
  ask: (request) => set({ request }),
  close: () => set({ request: null }),
}));
