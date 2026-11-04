import { test as base, expect, type Page } from '@playwright/test';
import { MeResponseSchema, type MeMembership } from '@vime/contracts';
import { VimeApi } from './api';
import { ORG_SLUG, OWNER_STATE_PATH, WEB_URL } from './env';

/*
 * Test fixtures:
 * - every test fails when the page throws or logs a console error (the web app logs contract
 *   mismatches with console.error in production builds and throws in development);
 * - `ownerApi`: the API as the signed-in owner (setup through the API, not the UI);
 * - `acme`: the owner's seeded organization (id, name, time zone).
 */

/** Console errors that are not app failures. */
const IGNORED_CONSOLE_ERRORS: readonly RegExp[] = [
  // Chromium logs every non-2xx response; tests assert what the UI shows for them instead
  // (e.g. the 401 of GET /v1/me on the login page, a 400 problem the page renders).
  /^Failed to load resource: the server responded with a status of \d+/,
];

export type Organization = MeMembership['organization'];

interface Fixtures {
  browserErrors: void;
  ownerApi: VimeApi;
  acme: Organization;
}

export const test = base.extend<Fixtures>({
  browserErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const text = message.text();
        if (IGNORED_CONSOLE_ERRORS.some((pattern) => pattern.test(text))) return;
        errors.push(`console.error: ${text}`);
      });
      await use();
      expect(errors, 'errors in the browser console').toEqual([]);
    },
    { auto: true },
  ],

  ownerApi: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({
      baseURL: WEB_URL,
      storageState: OWNER_STATE_PATH,
    });
    await use(new VimeApi(context));
    await context.dispose();
  },

  acme: async ({ ownerApi }, use) => {
    const me = await ownerApi.get('/v1/me', MeResponseSchema);
    const membership = me.memberships.find((m) => m.organization.slug === ORG_SLUG);
    if (!membership) throw new Error(`The owner has no membership in "${ORG_SLUG}"`);
    await use(membership.organization);
  },
});

export { expect };

/** The notes page of an organization, loaded (its title on screen). */
export async function openNotes(page: Page, orgId: string): Promise<void> {
  await page.goto(`/o/${orgId}/notas`);
  await expect(page.getByRole('heading', { name: 'Notas' })).toBeVisible();
}

/** A label nobody else uses in this run (suffix of names and emails created by a test). */
export function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}
