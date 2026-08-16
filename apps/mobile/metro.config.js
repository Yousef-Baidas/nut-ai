const { getDefaultConfig } = require('expo/metro-config')
const path = require('node:path')
const fs = require('node:fs')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '../..')

const config = getDefaultConfig(projectRoot)

// Watch the whole workspace so edits to packages/* hot-reload in the app.
config.watchFolders = [workspaceRoot]

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]
config.resolver.disableHierarchicalLookup = true

/**
 * Resolve TypeScript's `.js` extension convention from TypeScript SOURCE.
 *
 * `packages/*` are authored as ESM with explicit `./foo.js` specifiers, which is
 * what Node requires when those packages are consumed from their built `dist/`
 * output — and the eval harness consumes them exactly that way.
 *
 * `tsc` and Vitest both understand that `./foo.js` means `./foo.ts` when reading
 * source. Metro does not: it takes the specifier literally, finds no `bands.js`
 * next to `bands.ts`, and fails.
 *
 * Rather than dropping the extensions (which would break the Node build) or
 * forcing the app to consume `dist/` (which would break hot reload and mean the
 * app runs different bytes from the harness), rewrite the specifier here. This is
 * the only place the two conventions have to meet.
 */
const originalResolveRequest = config.resolver.resolveRequest

/**
 * Expo Go: alias HealthKit to a stub that reports itself as unavailable.
 *
 * HealthKit is the only native module this app uses that Expo Go does not
 * bundle, so it is the only thing preventing the app from running on a device
 * with no Xcode and no Mac. The stub exports a `__expoGoStub` marker that
 * `src/health/healthkit.ts` checks for, and treats exactly like an absent pod.
 * It must NOT throw — Metro routes a throwing module factory to
 * `reportFatalError`, which no caller's try/catch can intercept.
 * See stubs/react-native-healthkit.js.
 *
 * Set NUTAI_NATIVE=1 to bypass the alias and use the real pod in a native build.
 */
const EXPO_GO_STUBS = process.env.NUTAI_NATIVE
  ? {}
  : { '@kingstinct/react-native-healthkit': path.resolve(projectRoot, 'stubs/react-native-healthkit.js') }

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const stub = EXPO_GO_STUBS[moduleName]
  if (stub) {
    return { type: 'sourceFile', filePath: stub }
  }

  const isRelative = moduleName.startsWith('./') || moduleName.startsWith('../')

  if (isRelative && moduleName.endsWith('.js')) {
    const originDir = path.dirname(context.originModulePath)
    // Only rewrite when a sibling .ts actually exists, so a genuine .js file in
    // node_modules keeps resolving normally.
    const asTs = path.resolve(originDir, moduleName.replace(/\.js$/, '.ts'))
    if (fs.existsSync(asTs)) {
      moduleName = moduleName.replace(/\.js$/, '')
    }
  }

  return originalResolveRequest
    ? originalResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform)
}

module.exports = config
