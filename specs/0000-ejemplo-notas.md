# Notas por organización (ejemplo)

**Estado:** cerrada
**Rama:** `main`

Esta spec existe para mostrar una cerrada de verdad. `init-project` la borra.

**Objetivo:** un miembro de una organización puede guardar notas de texto que solo su organización ve.
**Problema:** no hay una entidad de dominio en el template que muestre el patrón completo de módulo.

**Alcance:**

- Crear, listar (paginado por cursor), ver, editar y borrar notas.
- Permisos `note.read` (todos los roles) y `note.write` (owner, admin, manager).
- Módulo detrás del feature flag `example`.

**Fuera de alcance:**

- Adjuntos, etiquetas, búsqueda por texto.
- Compartir notas entre organizaciones.

## Criterios de aceptación

- [x] Dado un miembro con `note.write`, cuando crea una nota, entonces aparece primera en la lista.
- [x] Dado un miembro sin `note.write`, cuando intenta crear, entonces 403.
- [x] Un usuario de la organización A no ve ni puede editar notas de la organización B (RLS, no solo filtro).
- [x] Cada creación, edición y borrado escribe un `activity_events`.

## Plan

- `modules/example/src/schema/notes.ts`, `notes.ts`, `rls.test.ts`
- `packages/contracts/src/example.ts`, `permissions.ts`
- `apps/api/src/routes/notes.ts`
- Migración `0003_example_notes.sql`

## Evidencia

- `pnpm check`: 2026-11-04, verde.
- Review: reviewer, 0 bloqueantes.

## Follow-ups

- Ninguno.
