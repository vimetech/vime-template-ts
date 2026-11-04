import { randomUUID } from 'node:crypto';
import { CreateInvitationResponseSchema } from '@vime/contracts';
import { apiPath, orgPath } from './support/api';
import { expect, openNotes, test, uniqueSuffix } from './support/fixtures';

/*
 * Navigation and actions follow the membership's permissions. The test invites a member (reads
 * the notes, writes nothing) the way the settings page does (an invitation bound to an email),
 * and she accepts it on the login page with email + password, which also signs her in.
 */

test.describe('member (no note.write)', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('sees the notes but no write actions', async ({ page, acme, ownerApi }) => {
    const email = `miembro.${uniqueSuffix()}@acme.test`;
    const invitation = await ownerApi.mutate(
      'POST',
      orgPath(acme.id, '/invitations'),
      CreateInvitationResponseSchema,
      { roleKeys: ['member'], email },
    );
    // She accepts the invitation on the login page: the redemption's session cookie signs her in.
    await page.goto('/login');
    await page
      .getByRole('button', { name: '¿Te invitaron por correo? Acepta tu invitación' })
      .click();
    await expect(page.getByRole('heading', { name: 'Aceptar invitación' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Código de invitación' }).fill(invitation.code);
    await page.getByRole('textbox', { name: 'Correo electrónico' }).fill(email);
    await page.getByRole('textbox', { name: 'Contraseña' }).fill('miembro-e2e-1');
    await page.getByRole('textbox', { name: 'Tu nombre' }).fill('Sofía Ramos');
    await page.getByRole('button', { name: 'Aceptar e ingresar' }).click();
    // Her only organization with a page here is Acme: she lands on its notes.
    await expect(page).toHaveURL(new RegExp(`/o/${acme.id}/notas`));

    await openNotes(page, acme.id);
    await expect(page.getByText('Sofía Ramos')).toBeVisible();
    await expect(page.getByText('Solo lectura', { exact: false })).toBeVisible();

    // No write actions anywhere on the page.
    await expect(page.getByRole('button', { name: 'Nueva nota' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Editar' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Eliminar' })).toHaveCount(0);

    // Navigation hides the pages of other permissions.
    const nav = page.getByRole('navigation', { name: 'Navegación principal' });
    await expect(nav.getByRole('link', { name: 'Notas' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Configuración' })).toHaveCount(0);

    // Hiding is cosmetic: the API refuses the write too.
    const refused = await page.request.post(apiPath(orgPath(acme.id, '/notes')), {
      headers: { 'idempotency-key': randomUUID() },
      data: { title: 'Nope' },
    });
    expect(refused.status()).toBe(403);
  });
});

test.describe('owner', () => {
  test('creates, edits and deletes a note', async ({ page, acme }) => {
    const title = `Nota e2e ${uniqueSuffix()}`;
    await openNotes(page, acme.id);
    await page.getByRole('button', { name: 'Nueva nota' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nueva nota' });
    await dialog.getByRole('textbox', { name: 'Título' }).fill(title);
    await dialog.getByRole('textbox', { name: 'Texto' }).fill('Escrita desde el navegador.');
    await dialog.getByRole('button', { name: 'Guardar' }).click();
    const item = page.getByRole('listitem').filter({ hasText: title });
    await expect(item).toBeVisible();

    await item.getByRole('button', { name: 'Editar' }).click();
    const edit = page.getByRole('dialog', { name: 'Editar nota' });
    await edit.getByRole('textbox', { name: 'Texto' }).fill('Editada.');
    await edit.getByRole('button', { name: 'Guardar' }).click();
    await expect(item.getByText('Editada.')).toBeVisible();

    await item.getByRole('button', { name: 'Eliminar' }).click();
    const confirm = page.getByRole('dialog', { name: '¿Eliminar la nota?' });
    await confirm.getByRole('button', { name: 'Eliminar' }).click();
    await expect(page.getByRole('listitem').filter({ hasText: title })).toHaveCount(0);
  });
});
