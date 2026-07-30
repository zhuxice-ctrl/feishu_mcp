/**
 * Closed project-provider registry.
 *
 * Providers are registered once per ecosystem key. Duplicate registration of
 * the same key is rejected — there is no plug-in discovery, no dynamic load,
 * no override. Lookup of an unknown key throws so a caller can never silently
 * fall through to a default provider.
 */

import type { DevelopmentEcosystem, DevelopmentProjectProvider } from "./types.js";

export class ProjectRegistry {
  private readonly providers = new Map<DevelopmentEcosystem, DevelopmentProjectProvider>();

  register(provider: DevelopmentProjectProvider): void {
    if (this.providers.has(provider.ecosystem)) {
      throw new Error(
        `project provider already registered for ecosystem: ${provider.ecosystem}`,
      );
    }
    this.providers.set(provider.ecosystem, provider);
  }

  get(ecosystem: DevelopmentEcosystem): DevelopmentProjectProvider {
    const provider = this.providers.get(ecosystem);
    if (!provider) {
      throw new Error(`no project provider registered for ecosystem: ${ecosystem}`);
    }
    return provider;
  }

  has(ecosystem: DevelopmentEcosystem): boolean {
    return this.providers.has(ecosystem);
  }
}
