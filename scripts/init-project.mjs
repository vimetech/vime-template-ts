#!/usr/bin/env node
/**
 * Renames the template into a project. Run once, right after "Use this template":
 *
 *   node scripts/init-project.mjs --name "Clínica Norte" --slug clinica-norte
 *
 * It replaces the project placeholders in CLAUDE.md and README.md, renames the root package, resets
 * the ADR log to this project's 0001, removes the example spec, and writes the template version the
 * project was born from. It does not touch @vime/* package names (they are the stack, not the project).
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .matchAll(/--(\w+)(?:[= ]("[^"]*"|\S+))?/g)
    .toArray()
    .map((m) => [m[1], (m[2] ?? 'true').replace(/^"|"$/g, '')]),
);

const name = args.name;
const slug =
  args.slug ??
  name
    ?.toLowerCase()
    .normalize('NFD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
if (!name || !slug) {
  console.error('Usage: node scripts/init-project.mjs --name "Project Name" [--slug project-name]');
  process.exit(1);
}

const root = resolve(import.meta.dirname, '..');
const pkgPath = resolve(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const templateVersion = pkg.templateVersion ?? '0.1.0';

const replaceIn = (file, pairs) => {
  const p = resolve(root, file);
  if (!existsSync(p)) return;
  let s = readFileSync(p, 'utf8');
  for (const [from, to] of pairs) s = s.replaceAll(from, to);
  writeFileSync(p, s);
};

replaceIn('CLAUDE.md', [
  ['<PROJECT_NAME>', name],
  ['nacido de `vime-template-ts` v0.1', `nacido de \`vime-template-ts\` v${templateVersion}`],
]);
replaceIn('README.md', [
  ['<PROJECT_NAME>', name],
  ['<PROJECT_SLUG>', slug],
]);
replaceIn('docker-compose.yml', [['vime-template', slug]]);

pkg.name = slug;
delete pkg.templateVersion;
pkg.vime = {
  template: 'vime-template-ts',
  templateVersion,
  createdAt: new Date().toISOString().slice(0, 10),
};
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

rmSync(resolve(root, 'specs/0000-ejemplo-notas.md'), { force: true });
rmSync(resolve(root, 'scripts/init-project.mjs'), { force: true });

console.log(
  `Proyecto "${name}" (${slug}) inicializado desde vime-template-ts v${templateVersion}.`,
);
console.log(
  'Siguiente: cp .env.example .env && pnpm install && pnpm db:bootstrap && pnpm db:migrate && pnpm check',
);
