/** Lookup helpers for the protected local development-server catalog. */

import type { CanonicalDevServer } from "./contracts.js";
import type { Workspace } from "../workspaces/types.js";

export function findDevServer(
  workspace: Workspace,
  serviceId: string,
): CanonicalDevServer | undefined {
  return workspace.services.find((service) => service.id === serviceId);
}
