import 'i18next';
import type { commonEsPE, webEsPE } from '@vime/i18n';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'web';
    resources: {
      web: typeof webEsPE;
      common: typeof commonEsPE;
    };
  }
}
