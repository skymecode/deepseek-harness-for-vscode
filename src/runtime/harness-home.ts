import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type * as vscode from 'vscode'

const MIGRATED = new Set<string>()

/** Recognize immutable V2/V3 generations as well as pre-versioned logs. */
const SESSION_ARTIFACT_NAME = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/u

export interface LegacySessionMigrationResult {
  copied: number
  skipped: number
}

/**
 * Copy every session directory under a legacy harness-home `sessions` root
 * into the current `sessions` root, skipping ids that already exist. The
 * legacy tree is never modified — an old install keeps a full backup of its
 * history. Idempotent: rerunning copies only what is still missing, so a
 * partial failure self-heals on the next startup.
 */
export function migrateLegacySessions(
  legacySessionsRoot: string,
  targetSessionsRoot: string,
): LegacySessionMigrationResult {
  if (!existsSync(legacySessionsRoot)) return { copied: 0, skipped: 0 }
  mkdirSync(targetSessionsRoot, { recursive: true })
  let copied = 0
  let skipped = 0
  for (const project of readdirSync(legacySessionsRoot, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const sourceProject = path.join(legacySessionsRoot, project.name)
    // An unreadable legacy project dir must never block startup.
    let sessionNames: string[]
    try {
      sessionNames = readdirSync(sourceProject, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      continue
    }
    for (const sessionName of sessionNames) {
      const source = path.join(sourceProject, sessionName)
      // Copy whole session directories, including earlier immutable generations.
      // Never rewrite a log ourselves or assume only the unversioned name exists.
      try {
        if (!readdirSync(source, { withFileTypes: true }).some((entry) => entry.isFile() && SESSION_ARTIFACT_NAME.test(entry.name))) continue
      } catch { continue }
      const target = path.join(targetSessionsRoot, project.name, sessionName)
      if (existsSync(target)) {
        skipped++
        continue
      }
      try {
        mkdirSync(path.dirname(target), { recursive: true })
        cpSync(source, target, { recursive: true, preserveTimestamps: true })
        copied++
      } catch {
        // A failed single-session copy must not abort the whole migration;
        // the idempotent re-scan picks it up on the next startup.
      }
    }
  }
  return { copied, skipped }
}

/**
 * The DSH CLI (and pre-VSIX harness builds) kept their harness home at
 * `~/.dsh`, with session logs under `~/.dsh/sessions`. When such an install
 * upgrades to this extension, every historical session must survive: copy
 * them into the stable home's sessions root once.
 *
 * Paths are built with `os.homedir()` + `path.join`, so the location resolves
 * per OS user on every platform: `~/.dsh/sessions` on POSIX, `C:\Users\<u>\.dsh\sessions`
 * on Windows. Each user migrates their own home; nothing is shared or global.
 */
export function legacyDshSessionsRoot(): string {
  return path.join(os.homedir(), '.dsh', 'sessions')
}

/**
 * Every legacy harness-home `sessions` root worth scanning, in priority order:
 * 1. An explicitly configured `DSH_HOME` — covers CLI/older builds launched
 *    with a custom home on any platform.
 * 2. The CLI default home `~/.dsh/sessions`.
 *
 * The stable extension home is always excluded so the migration can never
 * copy a root into itself. Missing roots are a no-op for the migrator.
 */
export function legacySessionsRoots(stableHome: string): string[] {
  const roots = new Set<string>()
  const envHome = process.env.DSH_HOME
  if (envHome) roots.add(path.join(envHome, 'sessions'))
  roots.add(legacyDshSessionsRoot())
  roots.delete(path.join(stableHome, 'sessions'))
  return [...roots]
}

/**
 * The extension's persistent harness home (session logs, provider settings,
 * credentials, attachments). It lives OUTSIDE VS Code's globalStorage because
 * VS Code removes an extension's globalStorage on uninstall and on "Reset
 * Extension State" — either silently wipes every session and the provider
 * configuration. A stable per-user directory (~/.dsh/vscode/harness-home)
 * survives extension reinstall, uninstall, and state resets.
 *
 * Legacy private globalStorage data is retained here. Session migration into
 * the shared official store is handled by shared-history's locked worker;
 * never copy official histories into a second, independently writable store.
 */
export function harnessHomePath(context: vscode.ExtensionContext): string {
  const stable = path.join(os.homedir(), '.dsh', 'vscode', 'harness-home')
  const legacy = path.join(context.globalStorageUri.fsPath, 'harness-home')
  migrateOnce(legacy, stable)
  return stable
}

function migrateOnce(legacy: string, stable: string): void {
  if (MIGRATED.has(stable)) return
  MIGRATED.add(stable)
  try {
    if (existsSync(stable) || !existsSync(legacy)) return
    mkdirSync(path.dirname(stable), { recursive: true })
    cpSync(legacy, stable, { recursive: true, preserveTimestamps: true })
  } catch {
    // A failed migration must not block the runtime; the extension simply
    // starts with a fresh stable home and the legacy copy is left untouched.
  }
}
