# 0001. Nacer de vime-template-ts (Stack VIME v1)

**Fecha:** 2026-11-04 · **Estado:** aceptada

## Contexto

Hasta 2026 cada proyecto de VIME arrancó de una carpeta vacía y tomó todas las decisiones de stack y estructura por
su cuenta (AutoAgent, vime-platform y CliniqAI no comparten una línea de base). Con agentes de código generando la
mayor parte del código, esa dispersión se multiplica: el agente reinventa convenciones en cada sesión.

## Opciones

- A: seguir eligiendo stack por proyecto.
- B: fijar un stack principal y un template del que nace todo proyecto nuevo.

## Decisión

B. El stack principal es el de `vimetech/vime-platform` (el único de los tres repos con lint, tests de aislamiento,
fronteras de módulos enforzadas y ADRs), extraído sin dominio como `vimetech/vime-template-ts`. Este proyecto nació
de su versión indicada en `CLAUDE.md`. Stack secundario oficial: NestJS + Prisma + Next.js, solo para CliniqAI.

## Consecuencias

- Un proyecto nuevo tiene convenciones, CI y reviewer desde el primer commit.
- Salir del stack requiere exigencia contractual o restricción técnica real, documentada en un ADR aquí.
- El template no sincroniza hacia atrás: este repo diverge de él desde el día uno y eso es intencional. Lo que se
  descubre útil aquí vuelve al template en la retro de cierre, con un bump de versión.
