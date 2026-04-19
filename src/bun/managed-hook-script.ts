import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MANAGED_HOOK_SCRIPT_MARKER } from "./loopndroll-core";

type BuildManagedHookScriptInput = {
  includeShebang: boolean;
};

function getHookRuntimeEntryCandidatesFromExecutablePath(maxLevels = 8) {
  const candidates: string[] = [];
  let currentDirectory = dirname(process.execPath);

  for (let level = 0; level < maxLevels; level += 1) {
    candidates.push(join(currentDirectory, "src", "bun", "hook-runtime-entry.ts"));
    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      break;
    }
    currentDirectory = parentDirectory;
  }

  return candidates;
}

function getHookRuntimeEntryCandidates() {
  const bundledCandidate = fileURLToPath(new URL("./hook-runtime-entry.ts", import.meta.url));
  const cwdCandidate = join(process.cwd(), "src", "bun", "hook-runtime-entry.ts");

  return [bundledCandidate, cwdCandidate, ...getHookRuntimeEntryCandidatesFromExecutablePath()];
}

function resolveHookRuntimeEntryModuleUrl() {
  const candidates = getHookRuntimeEntryCandidates();
  const existingCandidate = candidates.find((candidate) => existsSync(candidate));
  const resolvedPath = existingCandidate ?? candidates[0] ?? fileURLToPath(import.meta.url);
  return pathToFileURL(resolvedPath).href;
}

export function buildManagedHookScript({ includeShebang }: BuildManagedHookScriptInput) {
  const shebang = includeShebang ? "#!/usr/bin/env bun\n" : "";
  const hookRuntimeEntryModuleUrl = resolveHookRuntimeEntryModuleUrl();

  return `${shebang}// ${MANAGED_HOOK_SCRIPT_MARKER}
import ${JSON.stringify(hookRuntimeEntryModuleUrl)};
`;
}
