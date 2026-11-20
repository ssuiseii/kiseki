/**
 * Package-name → factory map, populated once by the composition root
 * (decision #37). Contains no routing logic by design.
 */

import type { AdapterFactory } from "./adapter"

export class AdapterRegistry {
  private readonly factories = new Map<string, AdapterFactory>()

  register(packageName: string, factory: AdapterFactory): void {
    if (this.factories.has(packageName)) {
      throw new Error(`adapter package already registered: ${packageName}`)
    }
    this.factories.set(packageName, factory)
  }

  factory(packageName: string): AdapterFactory | undefined {
    return this.factories.get(packageName)
  }

  has(packageName: string): boolean {
    return this.factories.has(packageName)
  }

  names(): string[] {
    return [...this.factories.keys()]
  }
}
