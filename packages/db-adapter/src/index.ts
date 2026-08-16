// @nutai/db-adapter — the one interface, two implementations.
//
// This entry point is PURE: interface, schema, migrations. No driver.
//
// The better-sqlite3 implementation is at `@nutai/db-adapter/node` and is Node
// only. The expo-sqlite implementation lives in apps/mobile/src/db and NOT in
// this package, because packages/* must stay importable under bare Node with
// zero React Native surface (PLAN.md §4.1) — an `import 'expo-sqlite'` here
// would fail the node-purity gate, which is the gate doing its job.
//
// That is what lets `eval/` run the REAL gram engine and the REAL resolver
// under Node against the golden set — currently seeded (synthetic,
// provenance-labelled); kitchen-scale-weighed cases replace it case by case.
export * from './types.js'
export * from './schema.js'
export * from './migrate.js'
