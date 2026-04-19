import { spawn, spawnSync } from "node:child_process";
import { copyFile, chmod, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const LOOPNDROLL_HOOK_CLI_FLAG = "--loopndroll-hook";

export type LoopndrollRuntimeMode = "development" | "packaged";

export type ManagedHookRuntimePaths = {
  appExecutablePath: string;
  binDirectoryPath: string;
  managedHookPath: string;
  managedHookRuntimePath: string | null;
  runtimeMode: LoopndrollRuntimeMode;
};

type ShellCommandInput = {
  command: string;
  cwd: string;
};

function isBunExecutablePath(executablePath: string) {
  const executableName = basename(executablePath).trim().toLowerCase();
  return executableName === "bun" || executableName === "bun.exe";
}

export function getLoopndrollRuntimeMode(): LoopndrollRuntimeMode {
  return isBunExecutablePath(process.execPath) ? "development" : "packaged";
}

export function getLoopndrollAppDirectoryPath() {
  if (process.platform === "win32") {
    const roamingAppData = process.env["APPDATA"]?.trim() || join(homedir(), "AppData", "Roaming");
    return join(roamingAppData, "loopndroll");
  }

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "loopndroll");
  }

  return join(
    process.env["XDG_DATA_HOME"]?.trim() || join(homedir(), ".local", "share"),
    "loopndroll",
  );
}

export function getManagedHookRuntimePaths(appDirectoryPath: string): ManagedHookRuntimePaths {
  const runtimeMode = getLoopndrollRuntimeMode();
  const binDirectoryPath = join(appDirectoryPath, "bin");

  if (process.platform === "win32") {
    return {
      appExecutablePath: process.execPath,
      binDirectoryPath,
      managedHookPath: join(binDirectoryPath, "loopndroll-hook.cmd"),
      managedHookRuntimePath:
        runtimeMode === "development" ? join(binDirectoryPath, "loopndroll-hook.mjs") : null,
      runtimeMode,
    };
  }

  if (runtimeMode === "packaged") {
    return {
      appExecutablePath: process.execPath,
      binDirectoryPath,
      managedHookPath: process.execPath,
      managedHookRuntimePath: null,
      runtimeMode,
    };
  }

  return {
    appExecutablePath: process.execPath,
    binDirectoryPath,
    managedHookPath: join(binDirectoryPath, "loopndroll-hook"),
    managedHookRuntimePath: null,
    runtimeMode,
  };
}

function quoteWindowsArgument(value: string) {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function quoteUnixArgument(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function quoteCommandArgument(value: string) {
  return process.platform === "win32" ? quoteWindowsArgument(value) : quoteUnixArgument(value);
}

export function buildCommandString(commandPath: string, args: string[]) {
  const quotedArgs = args.map((value) => quoteCommandArgument(value));
  return [quoteCommandArgument(commandPath), ...quotedArgs].join(" ");
}

async function ensureManagedRuntimeScript(
  paths: ManagedHookRuntimePaths,
  scriptContents: string,
  managedHookScriptMarker: string,
) {
  if (paths.runtimeMode !== "development") {
    return;
  }

  const runtimePath = paths.managedHookRuntimePath ?? paths.managedHookPath;
  const existingContent = await readFile(runtimePath, "utf8").catch(() => null);
  if (existingContent && !existingContent.includes(managedHookScriptMarker)) {
    const backupPath = `${runtimePath}.bak.${Date.now()}`;
    await copyFile(runtimePath, backupPath);
  }

  await writeFile(runtimePath, scriptContents, "utf8");
  if (process.platform !== "win32") {
    await chmod(runtimePath, 0o755);
  }
}

async function ensureWindowsLauncher(paths: ManagedHookRuntimePaths) {
  if (process.platform !== "win32") {
    return;
  }

  const launcher =
    paths.runtimeMode === "development"
      ? buildDevelopmentWindowsLauncher(paths)
      : buildPackagedWindowsLauncher(paths);

  await writeFile(paths.managedHookPath, launcher, "utf8");
}

function buildDevelopmentWindowsLauncher(paths: ManagedHookRuntimePaths) {
  const runtimePath = paths.managedHookRuntimePath;
  if (!runtimePath) {
    throw new Error("Managed hook runtime path is missing for Windows development mode.");
  }

  return [
    "@echo off",
    `${quoteWindowsArgument(paths.appExecutablePath)} ${quoteWindowsArgument(runtimePath)}`,
    "",
  ].join("\r\n");
}

function buildPackagedWindowsLauncher(paths: ManagedHookRuntimePaths) {
  return [
    "@echo off",
    `${quoteWindowsArgument(paths.appExecutablePath)} ${LOOPNDROLL_HOOK_CLI_FLAG}`,
    "",
  ].join("\r\n");
}

export async function ensureManagedHookArtifacts(
  paths: ManagedHookRuntimePaths,
  scriptContents: string,
  managedHookScriptMarker: string,
) {
  if (paths.runtimeMode !== "development" && process.platform !== "win32") {
    return;
  }

  if (paths.runtimeMode === "development") {
    await ensureManagedRuntimeScript(paths, scriptContents, managedHookScriptMarker);
  }
  await ensureWindowsLauncher(paths);
}

export async function hasManagedHookArtifacts(paths: ManagedHookRuntimePaths) {
  const commandExists = await stat(paths.managedHookPath)
    .then(() => true)
    .catch(() => false);
  if (!commandExists) {
    return false;
  }

  if (process.platform !== "win32") {
    return true;
  }

  if (paths.runtimeMode !== "development") {
    return true;
  }

  const runtimeExists = await stat(paths.managedHookRuntimePath ?? "")
    .then(() => true)
    .catch(() => false);
  return runtimeExists;
}

export function buildManagedHookCommand(paths: ManagedHookRuntimePaths, managedHookMarker: string) {
  if (process.platform === "win32") {
    return quoteCommandArgument(paths.managedHookPath);
  }

  if (paths.runtimeMode === "packaged") {
    return buildCommandString(paths.managedHookPath, [LOOPNDROLL_HOOK_CLI_FLAG, managedHookMarker]);
  }

  return buildCommandString(paths.managedHookPath, ["--hook", managedHookMarker]);
}

export function runPlatformShellCommand({ command, cwd }: ShellCommandInput) {
  if (process.platform === "win32") {
    return spawnSync(process.env["ComSpec"]?.trim() || "cmd.exe", ["/d", "/s", "/c", command], {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  }

  return spawnSync("/bin/sh", ["-lc", command], {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

export async function revealPathInFileManager(targetPath: string) {
  const command =
    process.platform === "win32"
      ? {
          program: "explorer.exe",
          args: ["/select,", targetPath],
        }
      : process.platform === "darwin"
        ? {
            program: "open",
            args: ["-R", targetPath],
          }
        : {
            program: "xdg-open",
            args: [dirname(targetPath)],
          };

  const child = spawn(command.program, command.args, {
    stdio: "ignore",
    detached: true,
  });

  child.unref();
}
