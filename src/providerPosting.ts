import type { FetchPlan, ReviewReference } from "./providerPlanning";

export class PostingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostingError";
  }
}

export function postingTool(reference: ReviewReference): "gh" | "glab" {
  return reference.provider === "github" ? "gh" : "glab";
}

export async function assertProviderAuth(reference: ReviewReference): Promise<void> {
  const tool = postingTool(reference);
  await runCommand([tool, "auth", "status"], `Provider posting blocked: ${tool} auth status failed`);
}

export async function postProviderSummary(reference: ReviewReference, plan: FetchPlan, body: string): Promise<void> {
  if (reference.provider === "github") {
    await runCommand(
      ["gh", "pr", "comment", String(reference.number), "--repo", reference.projectPath, "--body", body],
      "Provider posting failed: gh pr comment failed",
    );
    return;
  }

  await runCommand(
    ["glab", "mr", "comment", String(reference.number), "--repo", reference.projectPath, "-m", body],
    "Provider posting failed: glab mr comment failed",
  );
}

async function runCommand(command: string[], failurePrefix: string): Promise<void> {
  const proc = Bun.spawn({
    cmd: command,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
    throw new PostingError(`${failurePrefix}${detail}`);
  }
}
