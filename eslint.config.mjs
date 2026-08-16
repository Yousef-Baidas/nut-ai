import tseslint from 'typescript-eslint'

/**
 * The lint gate `npm run check` runs first (issue #10).
 *
 * Two jobs, in order of why this file exists at all:
 *
 * 1. Enforce the one invariant the code has always CLAIMED lint enforces:
 *    hex colours live only in `apps/mobile/src/theme/tokens.ts`. A hardcoded
 *    colour silently ignores dark mode and never gets contrast-checked, so
 *    the ban is an error, not a warning.
 *
 * 2. A typescript-eslint recommended baseline over the whole workspace, so
 *    `eslint . --max-warnings=0` means something beyond the colour rule.
 *
 * The tap-target rule (`MIN_TAP_TARGET`) is deliberately NOT here: a lint
 * rule flagging any width/height under 44 would fire on every divider and
 * icon, so that rule is a review convention — tokens.ts says so.
 */

const HEX_COLOUR_IN_STRING = '/#[0-9a-fA-F]{3,8}\\b/'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '.expo/**',
      'apps/mobile/.expo/**',
      'apps/mobile/expo-env.d.ts',
      '.superpowers/**',
      'tools/nutrition-data/out/**',
      'coverage/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    // Scripts and stubs are plain JS by design; the TS project rules that
    // assume type syntax stay out of them.
    files: ['**/*.js', '**/*.mjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['apps/mobile/**/*.ts', 'apps/mobile/**/*.tsx'],
    ignores: ['apps/mobile/src/theme/tokens.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: `Literal[value=${HEX_COLOUR_IN_STRING}]`,
          message:
            'Hex colours live only in src/theme/tokens.ts. Use a palette/theme token so dark mode and contrast checks can see it.',
        },
        {
          selector: `TemplateElement[value.raw=${HEX_COLOUR_IN_STRING}]`,
          message:
            'Hex colours live only in src/theme/tokens.ts. Use a palette/theme token so dark mode and contrast checks can see it.',
        },
      ],
    },
  },
)
