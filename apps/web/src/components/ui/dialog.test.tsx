import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog';

describe('Dialog', () => {
  it('closes itself when unmounted while open, before it leaves the document', () => {
    const { container, rerender } = render(
      <Dialog open onClose={vi.fn()} title="Detalle">
        <p>Contenido</p>
      </Dialog>,
    );
    const element = container.querySelector('dialog') as HTMLDialogElement;
    expect(element.open).toBe(true);
    // Closing a modal <dialog> that is still connected is what returns focus to its opener.
    let connectedWhenClosed: boolean | null = null;
    const close = element.close?.bind(element);
    element.close = () => {
      connectedWhenClosed = element.isConnected;
      if (close) close();
      else element.removeAttribute('open');
    };
    rerender(<></>);
    expect(connectedWhenClosed).toBe(true);
    expect(element.open).toBe(false);
  });
});
