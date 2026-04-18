# Windows-First Hook Runtime Design

## Goal

Make Loopndroll run on Windows out of the box, without WSL, Git Bash, or a separately installed Bun runtime for packaged app users.

The Windows-first refactor must keep Telegram working as a supported notification and control channel, including:

- Stop notifications
- Reply-to-continue flow
- `/reply`, `/mode`, `/status`, `/list`
- Telegram polling bridge

The refactor must also preserve local auto-continue behavior:

- Infinite
- Await Reply
- Completion Checks
- Max Turns 1 / 2 / 3

## Product Constraints

- Windows is the priority platform.
- No hidden runtime dependency on external `bun` for packaged app users.
- Notifications are not optional in supported behavior. Telegram must continue to work.
- Completion checks must run natively on Windows with stock system components.
- Existing Codex Hooks integration remains the control plane.

## Current Problems

The current implementation is effectively Unix-first:

- App data paths are hard-coded to macOS Application Support.
- Managed hook generation depends on a shebang `#!/usr/bin/env bun`.
- Completion checks are executed through `/bin/sh -lc`.
- Hook registration applies `chmod`.
- Revealing `hooks.json` uses `open -R`.

Those assumptions break native Windows support and make packaged app behavior depend on tooling that is not guaranteed to exist.

## Recommended Approach

Introduce a platform runtime layer and move hook execution into a reusable Bun module that can be launched in two modes:

- Packaged mode: the installed app executable runs hook mode directly.
- Development mode: a generated launcher script runs the hook module through the local Bun toolchain.

This removes the out-of-box packaged dependency on external Bun while keeping local development workable.

## Architecture

### 1. Platform runtime module

Create a new Bun-side platform module that owns:

- App support directory resolution
- Hook artifact paths
- Hook command generation for `hooks.json`
- Cross-platform shell execution for completion checks
- Cross-platform file reveal behavior
- Runtime mode detection for packaged vs development

This module becomes the single source of truth for platform decisions.

### 2. Reusable hook runtime module

Extract the managed hook logic from the generated inline script into a normal TypeScript module with a public entry such as:

- `runLoopndrollHookFromStdin()`

That module owns:

- Reading hook JSON payload from stdin
- Opening the app database
- Applying migrations
- Session registration
- Stop decision logic
- Notification delivery
- Telegram reply waiting behavior
- Writing hook JSON result to stdout

The existing generated script becomes a thin wrapper instead of the only implementation.

### 3. Packaged executable hook mode

Add CLI handling in the main Bun entrypoint:

- If process args include a dedicated flag such as `--loopndroll-hook`, run hook mode and exit.
- Otherwise start the desktop window as usual.

For packaged builds, Codex Hooks should call the app executable directly with the hook flag.

This is the key requirement for “works on any Windows out of the box”.

### 4. Development hook launcher

Keep a generated launcher for development environments.

On Windows:

- Generate a `.cmd` launcher that runs the hook wrapper script with Bun.

On Unix:

- Keep a script launcher with shebang and executable bit.

Development mode can continue assuming Bun is available because the app is being developed from source.

## Path Strategy

### App data directories

Use platform-appropriate app data roots:

- Windows: `%APPDATA%\\loopndroll`
- macOS: `~/Library/Application Support/loopndroll`
- Linux fallback: `~/.local/share/loopndroll`

Codex config remains under:

- `~/.codex/config.toml`
- `~/.codex/hooks.json`

### Hook artifacts

Store managed artifacts under the app data directory:

- Hook wrapper script
- Windows `.cmd` launcher when needed
- Hook debug logs
- Database

## Hook Registration Strategy

The registration code must build the command string from platform runtime data instead of assuming a single script path.

Expected behavior:

- Packaged app: register the packaged executable command with hook flag.
- Development on Windows: register `.cmd` launcher command.
- Development on Unix: register script path command.

Health checks must validate the correct artifact set for the current runtime mode.

## Completion Check Execution

Replace the hard-coded `/bin/sh -lc` execution with platform-aware shell execution.

Windows:

- Execute through `cmd.exe /d /s /c <command>`

Unix:

- Execute through `/bin/sh -lc <command>`

Scope for Windows support:

- Standard commands like `pnpm check`, `npm test`, `bun test`, `cargo test`, `pytest` should work.
- Bash-only syntax is not guaranteed on Windows and is outside first-pass compatibility.

This is acceptable because “native Windows out of the box” means native Windows shell behavior, not Bash emulation.

## Telegram and Notifications

Telegram remains fully supported and required in supported behavior.

Nothing in the Windows refactor should reduce Telegram capability:

- Polling bridge still starts from the desktop app process
- Notification delivery still occurs from hook runtime
- Reply targeting through receipts and awaiting-session tracking remains unchanged

Slack support can remain available, but Telegram is the must-keep path.

## File and Module Changes

### New modules

- `src/bun/platform-runtime.ts`
  Cross-platform paths, runtime mode detection, launcher creation, shell execution, reveal helpers.

- `src/bun/hook-runtime.ts`
  Extracted managed hook logic currently embedded in generated script chunks.

### Existing modules to change

- `src/bun/index.ts`
  Add hook CLI mode and early exit before window creation.

- `src/bun/hook-management.ts`
  Switch from direct script assumptions to platform runtime decisions.

- `src/bun/loopndroll-core.ts`
  Delegate path resolution to platform-aware logic and expand runtime path metadata.

- `src/bun/managed-hook-script.ts`
  Reduce to a thin wrapper that imports the reusable hook runtime.

- `src/bun/managed-hook-script/chunk-*.ts`
  Remove once hook logic is extracted.

## Failure Handling

If packaged hook mode cannot resolve a valid executable command:

- Hook registration should fail loudly with a clear error.

If Windows launcher generation fails in development:

- Registration should fail instead of silently writing broken hooks.

If `cmd.exe` execution fails:

- Completion checks should return a normal stop-blocking failure message with stderr tail.

## Testing Plan

### Static validation

- Typecheck
- Lint
- Format check

### Runtime validation

- Register hooks on Windows-compatible paths
- Confirm health status marks hooks registered
- Verify generated command differs correctly across runtime modes
- Verify completion checks runner uses platform shell
- Verify Telegram bridge startup still compiles and runs

### Repo commands

- `pnpm install`
- `pnpm check`

If the repository contains no dedicated automated tests beyond checks, `pnpm check` is the minimum verification gate. If runtime-specific failures appear during implementation, add targeted validation where practical.

## Risks

- Packaged executable hook mode depends on app startup being able to branch before window initialization.
- Electrobun runtime behavior may differ between dev and packaged execution.
- Quoting rules for Windows command strings in `hooks.json` must be exact.

## Risk Mitigation

- Centralize command-string construction in one module.
- Keep development and packaged modes explicit.
- Preserve the old script-wrapper concept as a fallback for development only.
- Verify command generation with deterministic unit-like helper outputs where possible.

## Implementation Order

1. Add platform runtime module and path model.
2. Extract hook runtime into a normal TypeScript module.
3. Add CLI hook mode to `src/bun/index.ts`.
4. Replace hook registration to use runtime-aware command generation.
5. Replace completion check execution with platform-aware shell execution.
6. Replace macOS-only reveal behavior with cross-platform behavior.
7. Remove obsolete chunk-based hook implementation.
8. Run install and repository checks, then fix regressions.
