import { useState } from 'react';
import { useT } from '../../lib/i18n-hook';
import { Button, type ButtonProps } from './Button';

/** Copies `text` to the clipboard and confirms it for a moment. */
export function CopyButton({
  text,
  label,
  ...props
}: { text: string; label?: string } & Omit<ButtonProps, 'onClick'>) {
  const { t } = useT();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <Button
      icon={state === 'copied' ? 'check' : 'copy'}
      {...props}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState('copied');
        } catch {
          setState('failed');
        }
        setTimeout(() => setState('idle'), 2000);
      }}
    >
      <span aria-live="polite">
        {state === 'copied'
          ? t('actions.copied')
          : state === 'failed'
            ? t('actions.copyFailed')
            : (label ?? t('actions.copy'))}
      </span>
    </Button>
  );
}
