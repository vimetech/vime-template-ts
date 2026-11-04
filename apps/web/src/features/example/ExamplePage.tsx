import {
  CreateNoteSchema,
  NoteSchema,
  UpdateNoteSchema,
  page,
  type Note,
  type Page,
} from '@vime/contracts';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { RequirePermission } from '../../components/RequirePermission';
import {
  Button,
  Card,
  Dialog,
  DialogActions,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Input,
  LoadingState,
  PageHeader,
  ProblemAlert,
  Textarea,
  useToast,
} from '../../components/ui';
import { api } from '../../lib/client';
import { problemFieldErrors, validateWith, type FieldErrors } from '../../lib/forms';
import { useT } from '../../lib/i18n-hook';
import { useOrg } from '../../lib/org';
import { usePresentation } from '../../lib/presentation';
import { invalidateOrg, keys, orgPath } from '../../lib/queries';
import { formatDateTime } from '../../lib/time';
import { useFormatLocale } from '../../lib/use-format';
import { useIntentKey } from '../../lib/use-intent-key';

/*
 * The example feature: the notes of `modules/example` through `/v1/orgs/:orgId/notes`. The shape
 * every feature page follows: a permission gate, queries keyed under the organization, mutations
 * with an Idempotency-Key per intent, contract validation before sending, and the kit's states
 * (loading, empty, error). Replace it with the first real page of the project.
 */

const NotesPageSchema = page(NoteSchema);

export function ExamplePage() {
  return (
    <RequirePermission anyOf={['note.read']}>
      <Notes />
    </RequirePermission>
  );
}

function Notes() {
  const { t } = useT();
  const { orgId, can, organization } = useOrg();
  const locale = useFormatLocale();
  const presentation = usePresentation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Note | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Note | null>(null);
  const canWrite = can('note.write');
  const notes = useInfiniteQuery({
    queryKey: keys.notes(orgId),
    queryFn: ({ pageParam, signal }): Promise<Page<Note>> =>
      api.get(orgPath(orgId, '/notes'), NotesPageSchema, {
        query: { limit: 50, cursor: pageParam },
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = notes.data?.pages.flatMap((p) => p.items) ?? [];
  const when = (iso: string) => formatDateTime(iso, organization.timezone, locale);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5">
      <PageHeader
        title={t('notes.title')}
        description={t('notes.description')}
        actions={
          canWrite ? (
            <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
              {t('notes.new')}
            </Button>
          ) : null
        }
      />
      {canWrite ? null : (
        <p className="flex items-start gap-2.5 rounded-xl border border-sky-200 bg-sky-50 px-3.5 py-3 text-sm text-sky-900">
          <Icon name="lock" className="mt-px size-4 text-sky-600" strokeWidth={2} />
          {t('notes.readOnly')}
        </p>
      )}
      {notes.isPending ? (
        <LoadingState />
      ) : notes.isError ? (
        <ErrorState error={notes.error} onRetry={() => void notes.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon="notes" title={t('notes.empty')}>
          {canWrite ? t('notes.emptyHint') : null}
        </EmptyState>
      ) : (
        <Card flush>
          <ul aria-label={t('notes.title')} className="divide-y divide-slate-100">
            {items.map((note) => (
              <li
                key={note.id}
                className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3 sm:px-5"
              >
                <div className="min-w-0 flex-1 basis-56">
                  <p className="text-sm font-medium text-slate-900">{note.title}</p>
                  <p className="mt-0.5 text-sm whitespace-pre-line text-slate-600">
                    {note.body ? presentation.text(note.body) : t('notes.noBody')}
                  </p>
                  <p className="mt-1 text-xs text-slate-500 tabular-nums">
                    {note.updatedAt
                      ? t('labels.updatedAt', { time: when(note.updatedAt) })
                      : t('labels.createdAt', { time: when(note.createdAt) })}
                  </p>
                </div>
                {canWrite ? (
                  <div className="flex gap-1.5">
                    <Button size="sm" icon="pencil" onClick={() => setEditing(note)}>
                      {t('actions.edit')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="trash"
                      onClick={() => setDeleting(note)}
                    >
                      {t('actions.delete')}
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          {notes.hasNextPage ? (
            <div className="border-t border-slate-100 p-3 text-center">
              <Button
                size="sm"
                loading={notes.isFetchingNextPage}
                onClick={() => void notes.fetchNextPage()}
              >
                {t('notes.loadMore')}
              </Button>
            </div>
          ) : null}
        </Card>
      )}
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? t('notes.new') : t('notes.edit')}
        size="sm"
      >
        {editing !== null ? (
          <NoteForm
            note={editing === 'new' ? null : editing}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              toast.success(t('states.saved'));
              void invalidateOrg(queryClient, orgId, 'notes');
            }}
          />
        ) : null}
      </Dialog>
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={t('notes.deleteTitle')}
        confirmLabel={t('actions.delete')}
        tone="danger"
        onConfirm={async () => {
          if (!deleting) return;
          await api.mutate('DELETE', orgPath(orgId, `/notes/${deleting.id}`), { schema: null });
          toast.success(t('notes.deleted'));
          await invalidateOrg(queryClient, orgId, 'notes');
        }}
      >
        {t('notes.deleteBody', { title: deleting?.title ?? '' })}
      </ConfirmDialog>
    </div>
  );
}

/** Creates a note (`note` null) or edits one; the contract validates the body before it is sent. */
function NoteForm({
  note,
  onCancel,
  onSaved,
}: {
  note: Note | null;
  onCancel: () => void;
  onSaved: (saved: Note) => void;
}) {
  const { t } = useT();
  const { orgId } = useOrg();
  const [title, setTitle] = useState(note?.title ?? '');
  const [body, setBody] = useState(note?.body ?? '');
  const [errors, setErrors] = useState<FieldErrors>({});
  const intent = useIntentKey();
  const save = useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      note
        ? api.mutate('PATCH', orgPath(orgId, `/notes/${note.id}`), {
            body: input,
            schema: NoteSchema,
            idempotencyKey: intent.keyFor({ id: note.id, ...input }),
          })
        : api.mutate('POST', orgPath(orgId, '/notes'), {
            body: input,
            schema: NoteSchema,
            idempotencyKey: intent.keyFor(input),
          }),
    onSuccess: (saved) => {
      intent.reset();
      onSaved(saved);
    },
    onError: (error) => setErrors(problemFieldErrors(error)),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const input = { title: title.trim(), body: body.trim() };
    const checked = validateWith(t, note ? UpdateNoteSchema : CreateNoteSchema, input);
    if (!checked.ok) return setErrors(checked.errors);
    setErrors({});
    save.mutate(input);
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
      <Field label={t('notes.noteTitle')} required error={errors['title']}>
        {(props) => (
          <Input
            {...props}
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
        )}
      </Field>
      <Field label={t('notes.body')} hint={t('notes.bodyHint')} error={errors['body']}>
        {(props) => (
          <Textarea {...props} rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
        )}
      </Field>
      {save.isError ? <ProblemAlert error={save.error} /> : null}
      <DialogActions>
        <Button onClick={onCancel}>{t('actions.cancel')}</Button>
        <Button type="submit" variant="primary" loading={save.isPending}>
          {t('actions.save')}
        </Button>
      </DialogActions>
    </form>
  );
}
