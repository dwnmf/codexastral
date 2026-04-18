import { MANAGED_HOOK_SCRIPT_MARKER } from "./loopndroll-core";

type BuildManagedHookScriptInput = {
  includeShebang: boolean;
};

const hookRuntimeEntryModuleUrl = new URL("./hook-runtime-entry.ts", import.meta.url).href;

export function buildManagedHookScript({ includeShebang }: BuildManagedHookScriptInput) {
  const shebang = includeShebang ? "#!/usr/bin/env bun\n" : "";
  return `${shebang}// ${MANAGED_HOOK_SCRIPT_MARKER}
import ${JSON.stringify(hookRuntimeEntryModuleUrl)};
`;
}
