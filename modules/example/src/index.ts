/**
 * @vime/example: the example domain module (notes per organization). It is the layer slot for the
 * first real module of a project: copy its shape (schema/, a service file, rls.test.ts, the
 * contracts in packages/contracts/src/example.ts, the routes in apps/api/src/routes/notes.ts) and
 * replace notes with the real domain.
 */
export { createNote, getNote, listNotes, updateNote, deleteNote } from './notes';
