import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MANAGED_HOOK_SCRIPT_MARKER } from "./loopndroll-core";

type BuildManagedHookScriptInput = {
  includeShebang: boolean;
};

function getRepositoryRootFromExecutablePath() {
  return dirname(dirname(dirname(dirname(process.execPath))));
}

function getHookRuntimeEntryCandidates() {
  const bundledCandidate = fileURLToPath(new URL("./hook-runtime-entry.ts", import.meta.url));
  const cwdCandidate = join(process.cwd(), "src", "bun", "hook-runtime-entry.ts");
  const executableCandidate = join(
    getRepositoryRootFromExecutablePath(),
    "src",
    "bun",
    "hook-runtime-entry.ts",
  );

  return [bundledCandidate, cwdCandidate, executableCandidate];
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
