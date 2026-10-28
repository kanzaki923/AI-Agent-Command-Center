import { useConfirm } from '../../store/confirm';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';

export function ConfirmDialog() {
  const request = useConfirm((s) => s.request);
  const close = useConfirm((s) => s.close);
  return (
    <Dialog
      open={!!request}
      onOpenChange={(o) => !o && close()}
      title={request?.title ?? ''}
      description={request?.body}
      className="w-[440px]"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            キャンセル
          </Button>
          <Button
            variant={request?.danger ? 'danger' : 'primary'}
            autoFocus
            onClick={() => {
              const r = request;
              close();
              r?.onConfirm();
            }}
          >
            {request?.confirmLabel}
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  );
}
