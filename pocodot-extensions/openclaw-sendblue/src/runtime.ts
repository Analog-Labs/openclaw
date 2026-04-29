// ---------------------------------------------------------------------------
// Runtime accessor — stores the PluginRuntime reference provided by OpenClaw
// ---------------------------------------------------------------------------

// PluginRuntime is provided by OpenClaw at load time via api.runtime.
// We store it here so all modules can access it without circular deps.

let runtime: any = null;

export function setSendblueRuntime(next: any): void {
  runtime = next;
}

export function getSendblueRuntime(): any {
  if (!runtime) {
    throw new Error(
      "Sendblue runtime not initialized — plugin not loaded correctly"
    );
  }
  return runtime;
}
