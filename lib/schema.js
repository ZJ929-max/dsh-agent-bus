/**
 * lib/schema.js — resolve Schemastery without breaking a link-installed plugin.
 *
 * A plugin that is installed from a local directory is linked from OUTSIDE the
 * profile's node_modules, so a bare `import '@deepseek-ai/schemastery'` does not
 * resolve (measured: ERR_MODULE_NOT_FOUND from C:\dev\agent-bus). A published
 * plugin lives inside the profile tree, so the bare import works there.
 *
 * Order: bare specifier first (published layout), then the same package reached
 * through every profile directory we can see (linked layout). If none resolves,
 * `Config` stays undefined and Cordis treats the plugin as having no schema —
 * `apply()` still reads the row config with its own defaults, so behaviour is
 * unchanged. Never fabricate a JSON-Schema-shaped object: without `~standard`
 * Cordis throws at activation and the plugin silently stops applying.
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

/** @type {any} resolved Schemastery namespace, or null. */
let Schema = null
/** Which channel answered: `schemastery`, `profile:<dir>`, or `none`. */
export let SCHEMA_SOURCE = 'none'
/** Why the official package was not usable ('' when it was). */
export let SCHEMA_ERROR = ''

/**
 * Directories whose `node_modules` may hold the official Schemastery: the
 * profile the plugin was installed into, and any other profile on this machine.
 * @returns candidate profile roots, nearest first.
 */
function profileRoots() {
  const roots = []
  const explicit = process.env.DSH_PROFILE_DIR
  if (explicit) roots.push(explicit)
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  try {
    for (const name of fs.readdirSync(path.join(home, 'profiles'))) {
      const candidate = path.join(home, 'profiles', name)
      if (!roots.includes(candidate)) roots.push(candidate)
    }
  } catch {
    // No profiles directory: only the bare import can help.
  }
  return roots
}

/** @returns the Schemastery namespace, or null. */
function fromBareSpecifier() {
  // Dynamic import keeps a missing package from failing module linking.
  return import('@deepseek-ai/schemastery').then(
    mod => {
      const candidate = mod && (mod.default || mod)
      return candidate && typeof candidate.object === 'function' ? candidate : null
    },
    err => {
      SCHEMA_ERROR = err instanceof Error ? err.message.split('\n')[0] : String(err)
      return null
    },
  )
}

/**
 * Reach the package through one profile's resolution chain (CJS `require`
 * walks `node_modules` upward from the given file).
 * @param root - profile directory.
 * @returns the namespace, or null.
 */
function fromProfile(root) {
  try {
    const requireFrom = createRequire(path.join(root, 'package.json'))
    const candidate = requireFrom('@deepseek-ai/schemastery')
    return candidate && typeof candidate.object === 'function' ? candidate : null
  } catch (err) {
    if (!SCHEMA_ERROR) SCHEMA_ERROR = err instanceof Error ? err.message.split('\n')[0] : String(err)
    return null
  }
}

Schema = await fromBareSpecifier()
if (Schema) {
  SCHEMA_SOURCE = 'schemastery'
} else {
  for (const root of profileRoots()) {
    Schema = fromProfile(root)
    if (Schema) {
      SCHEMA_SOURCE = `profile:${root}`
      SCHEMA_ERROR = ''
      break
    }
  }
}

export { Schema }

/**
 * Build `Config` with the official namespace; `undefined` when it is missing.
 * The build itself is guarded too: a partially compatible Schemastery that
 * lacks one helper must degrade to "no schema", not fail activation.
 * @param build - receives the namespace, returns the schema.
 * @returns the Config schema, or undefined.
 */
export function buildConfig(build) {
  if (!Schema) return undefined
  try {
    return build(Schema)
  } catch (err) {
    SCHEMA_ERROR = `schema build failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`
    return undefined
  }
}
