import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { test as setup, expect } from '@playwright/test';
import { apiPath } from './support/api';
import { OWNER, OWNER_STATE_PATH } from './support/env';

/*
 * Signs the seeded owner in once through the API and saves the session cookie for the specs
 * (`storageState` of the chromium project). Sign-in is rate limited (10 a minute per IP), so the
 * specs reuse this session instead of signing in each time; only the login spec uses the form.
 */
setup('owner session', async ({ request }) => {
  const response = await request.post(apiPath('/auth/sign-in/email'), {
    data: { email: OWNER.email, password: OWNER.password },
  });
  expect(response.status(), await response.text()).toBe(200);
  mkdirSync(dirname(OWNER_STATE_PATH), { recursive: true });
  await request.storageState({ path: OWNER_STATE_PATH });
});
