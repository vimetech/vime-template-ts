// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Architectural boundaries (see docs/architecture.md). Each layer may only import the listed
 * workspace packages; everything else under @vime/* is forbidden. Raw database access (pg,
 * drizzle-orm/node-postgres) is only allowed inside packages/db.
 */
const ALL = [
  'kernel',
  'contracts',
  'db',
  'i18n',
  'platform',
  'example',
  'api',
  'worker',
  'web',
  'config',
];

/** @type {Array<{ files: string[]; allow: string[]; allowRawDb?: boolean }>} */
const LAYERS = [
  { files: ['packages/kernel/**'], allow: [] },
  { files: ['packages/contracts/**'], allow: ['kernel'] },
  { files: ['packages/db/**'], allow: ['kernel'], allowRawDb: true },
  { files: ['packages/i18n/**'], allow: [] },
  { files: ['modules/platform/**'], allow: ['db', 'kernel', 'contracts'] },
  // Domain modules sit above platform: each one lists the modules below it.
  { files: ['modules/example/**'], allow: ['platform', 'db', 'kernel', 'contracts'] },
  {
    files: ['apps/api/**', 'apps/worker/**'],
    allow: ['kernel', 'contracts', 'db', 'i18n', 'platform', 'example'],
  },
  { files: ['apps/web/**'], allow: ['contracts', 'kernel', 'i18n'] },
];

const rawDbPaths = [
  { name: 'pg', message: 'Use @vime/db (withTenant/withUser/withSystem) instead of pg.' },
  {
    name: 'drizzle-orm/node-postgres',
    message: 'Use @vime/db (withTenant/withUser/withSystem) instead of a raw drizzle client.',
  },
];

const boundaryConfigs = LAYERS.map((layer) => {
  const forbidden = ALL.filter((p) => !layer.allow.includes(p));
  return {
    files: layer.files.map((f) => `${f}/*.{ts,tsx}`),
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: layer.allowRawDb ? [] : rawDbPaths,
          patterns: forbidden.length
            ? [
                {
                  group: forbidden.flatMap((p) => [`@vime/${p}`, `@vime/${p}/*`]),
                  message: `Architectural boundary: this layer may only import @vime/{${layer.allow.join(',')}}.`,
                },
              ]
            : [],
        },
      ],
    },
  };
});

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/migrations/**',
      'apps/web/src/routeTree.gen.ts',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  ...boundaryConfigs,
);
