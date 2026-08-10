export type NodeDevelopmentAction = "pnpm_version" | "test_run" | "build" | "typecheck";

export const NODE_ACTIONS: Readonly<Record<NodeDevelopmentAction, {
  executable: "pnpm";
  args: readonly string[];
}>> = {
  pnpm_version: { executable: "pnpm", args: ["--version"] },
  test_run: { executable: "pnpm", args: ["test:run"] },
  build: { executable: "pnpm", args: ["build"] },
  typecheck: { executable: "pnpm", args: ["typecheck"] },
};

export function resolveNodeAction(action: NodeDevelopmentAction) {
  const resolved = NODE_ACTIONS[action];
  return { executable: resolved.executable, args: [...resolved.args] };
}
