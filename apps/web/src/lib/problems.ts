import type { AppT } from './i18n-hook';
import { commonEsPE } from '@vime/i18n/common';
import { ApiContractError, ApiProblem } from './api';

type ProblemKey = keyof typeof commonEsPE.problem;

function isProblemKey(code: string): code is ProblemKey {
  return Object.hasOwn(commonEsPE.problem, code);
}

export interface ProblemText {
  /** Localized summary chosen from the problem `code`. */
  message: string;
  /** The server's own detail (technical, may be English), shown as secondary text. */
  detail: string | undefined;
}

/** What to tell the user about an error: localized by `code`, never by the server's title. */
export function problemText(t: AppT, error: unknown): ProblemText {
  if (error instanceof ApiProblem) {
    const key: ProblemKey = isProblemKey(error.code) ? error.code : 'unknown';
    const detail = error.detail && error.detail !== error.title ? error.detail : undefined;
    return { message: t(`common:problem.${key}`), detail };
  }
  if (error instanceof ApiContractError) {
    return { message: t('common:problem.unknown'), detail: error.message };
  }
  return {
    message: t('common:problem.unknown'),
    detail: error instanceof Error ? error.message : undefined,
  };
}

export function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiProblem && error.status === 401;
}
