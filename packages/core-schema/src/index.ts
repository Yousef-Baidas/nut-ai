// @nutai/core-schema — the Zod source of truth. Pure TypeScript, no React Native
// surface (docs/inherited-design.md II §4.1), so the eval harness can import it under plain Node.
// The harness (`eval/src/runner.ts`) does exactly that, against a currently
// seeded (synthetic, provenance-labelled) golden set — kitchen-scale-weighed
// cases replace it case by case.
export * from './vision-payload.js'
export * from './domain.js'
export * from './wire-schema.js'
export * from './web-lookup.js'
export * from './label-scan.js'
export * from './receipt-scan.js'
export * from './exercise-estimate.js'
