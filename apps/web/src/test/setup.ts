import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { initI18n } from '../i18n';

// Tests render in es-PE, the primary UI language.
initI18n('es-PE');

afterEach(() => {
  cleanup();
});
