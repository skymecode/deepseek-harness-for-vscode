import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'

const MIGRATED = new Set<string>()

/** Physical artifacts that make a directory a DSH session log. */
const SESSION_ARTIFACT_NAMES = ['session.jsonl.zstd', 'session.jsonl']

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
      if (!SESSION_ARTIFACT_NAMES.some((name) => existsSync(path.join(source, name)))) continue
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
 */
export function legacyDshSessionsRoot(): string {
  return path.join(os.homedir(), '.dsh', 'sessions')
}

/**
 * The extension's persistent harness home (session logs, provider settings,
 * credentials, attachments). It lives OUTSIDE VS Code's globalStorage because
 * VS Code removes an extension's globalStorage on uninstall and on "Reset
 * Extension State" — either silently wipes every session and the provider
 * configuration. A stable per-user directory (~/.dsh/vscode/harness-home)
 * survives extension reinstall, uninstall, and state resets.
 *
 * Two legacy homes are migrated once so an existing install keeps its data on
 * upgrade: the previous extension home under globalStorage, and the DSH
 * CLI/older-build home at ~/.dsh/sessions.
 */
export function harnessHomePath(context: vscode.ExtensionContext): string {
  const stable = path.join(os.homedir(), '.dsh', 'vscode', 'harness-home')
  const legacy = path.join(context.globalStorageUri.fsPath, 'harness-home')
  migrateOnce(legacy, stable)
  migrateLegacySessions(legacyDshSessionsRoot(), path.join(stable, 'sessions'))
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
