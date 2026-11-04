import { useMutation } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useT } from '../lib/i18n-hook';
import { Button, Dialog, DialogActions, Field, ProblemAlert, Textarea } from './ui';

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  /** Ask for a free-text reason/note (required when `reasonRequired`). */
  reasonLabel?: string;
  reasonRequired?: boolean;
  /**
   * Runs the action; the dialog shows its error, or closes when it resolves. It runs as a TanStack
   * mutation, so the app-wide mutation error handler sees its failures (a 401 goes to the login).
   */
  onConfirm: (reason: string) => Promise<unknown>;
}

export function ConfirmDialog({
  open,
  onClose,
  title,
  children,
  confirmLabel,
  tone = 'primary',
  reasonLabel,
  reasonRequired = false,
  onConfirm,
}: ConfirmDialogProps) {
  const { t } = useT();
  return (
    <Dialog open={open} onClose={onClose} title={title} size="sm">
      {open ? (
        <ConfirmBody
          onClose={onClose}
          confirmLabel={confirmLabel}
          tone={tone}
          reasonLabel={reasonLabel}
          reasonRequired={reasonRequired}
          onConfirm={onConfirm}
          cancelLabel={t('actions.cancel')}
        >
          {children}
        </ConfirmBody>
      ) : null}
    </Dialog>
  );
}

function ConfirmBody({
  children,
  onClose,
  confirmLabel,
  cancelLabel,
  tone,
  reasonLabel,
  reasonRequired,
  onConfirm,
}: Omit<ConfirmDialogProps, 'open' | 'title'> & { cancelLabel: string }) {
  const [reason, setReason] = useState('');
  // useMutation reads the latest options on every render, so the newest `onConfirm` runs.
  const action = useMutation({ mutationFn: (value: string) => onConfirm(value) });
  const missingReason = reasonRequired && reason.trim() === '';

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (missingReason || action.isPending) return;
        try {
          await action.mutateAsync(reason.trim());
          onClose();
        } catch {
          // Shown below (action.error); a 401 is also handled by the MutationCache.
        }
      }}
    >
      {children ? <div className="text-sm leading-relaxed text-slate-600">{children}</div> : null}
      {reasonLabel ? (
        <Field label={reasonLabel} required={reasonRequired}>
          {(props) => (
            <Textarea
              {...props}
              value={reason}
              maxLength={2000}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
      ) : null}
      {action.isError ? <ProblemAlert error={action.error} /> : null}
      <DialogActions>
        <Button onClick={onClose}>{cancelLabel}</Button>
        <Button
          type="submit"
          variant={tone === 'danger' ? 'danger' : 'primary'}
          loading={action.isPending}
          disabled={missingReason}
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </form>
  );
}
