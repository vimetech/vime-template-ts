import {
  CreateNoteSchema,
  ListNotesQuerySchema,
  NoteSchema,
  UpdateNoteSchema,
  UuidSchema,
  page,
} from '@vime/contracts';
import { createNote, deleteNote, getNote, listNotes, updateNote } from '@vime/example';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { mutate } from '../context/idempotency';
import { requirePermission } from '../context/request-context';
import { problemResponses } from '../http/problem';
import {
  AUTHENTICATED,
  MutationHeadersSchema,
  OrgParamsSchema,
  V1HeadersSchema,
  exampleGuard,
} from './common';

const NoteParamsSchema = OrgParamsSchema.extend({ noteId: UuidSchema });

/**
 * /v1/orgs/:orgId/notes: the example module's routes. Reads need `note.read`, writes `note.write`,
 * and every route the `example` feature (`exampleGuard`). Writes go through `mutate` (one
 * withTenant transaction, Idempotency-Key replay).
 */
export const noteRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['notes'];
  const read = exampleGuard(requirePermission('note.read'));
  const write = exampleGuard(requirePermission('note.write'));

  app.get(
    '/notes',
    {
      schema: {
        tags,
        summary: 'Notes, newest first',
        description: 'Cursor pagination: pass `nextCursor` as `cursor` for the next page.',
        security: AUTHENTICATED,
        params: OrgParamsSchema,
        querystring: ListNotesQuerySchema,
        headers: V1HeadersSchema,
        response: { 200: page(NoteSchema), ...problemResponses },
      },
      preHandler: read,
    },
    async (request) => request.tenant((tx) => listNotes(tx, request.auth.orgId, request.query)),
  );

  app.get(
    '/notes/:noteId',
    {
      schema: {
        tags,
        summary: 'Get a note',
        security: AUTHENTICATED,
        params: NoteParamsSchema,
        headers: V1HeadersSchema,
        response: { 200: NoteSchema, ...problemResponses },
      },
      preHandler: read,
    },
    async (request) =>
      request.tenant((tx) => getNote(tx, request.auth.orgId, request.params.noteId)),
  );

  app.post(
    '/notes',
    {
      schema: {
        tags,
        summary: 'Create a note',
        security: AUTHENTICATED,
        params: OrgParamsSchema,
        headers: MutationHeadersSchema,
        body: CreateNoteSchema,
        response: { 201: NoteSchema, ...problemResponses },
      },
      preHandler: write,
    },
    async (request, reply) =>
      mutate(request, reply, (tx, actor) => createNote(tx, actor, request.body), { status: 201 }),
  );

  app.patch(
    '/notes/:noteId',
    {
      schema: {
        tags,
        summary: 'Update a note',
        security: AUTHENTICATED,
        params: NoteParamsSchema,
        headers: MutationHeadersSchema,
        body: UpdateNoteSchema,
        response: { 200: NoteSchema, ...problemResponses },
      },
      preHandler: write,
    },
    async (request, reply) =>
      mutate(request, reply, (tx, actor) =>
        updateNote(tx, actor, request.params.noteId, request.body),
      ),
  );

  app.delete(
    '/notes/:noteId',
    {
      schema: {
        tags,
        summary: 'Delete a note',
        security: AUTHENTICATED,
        params: NoteParamsSchema,
        headers: MutationHeadersSchema,
        response: { 204: z.null(), ...problemResponses },
      },
      preHandler: write,
    },
    async (request, reply) =>
      mutate(
        request,
        reply,
        async (tx, actor) => {
          await deleteNote(tx, actor, request.params.noteId);
          return null;
        },
        { status: 204 },
      ),
  );
};
