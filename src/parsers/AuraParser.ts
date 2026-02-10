import { readFileSync } from 'fs';
import type { Dependency } from '../types.js';
import { DependencyWeightCalculator } from '../utils/DependencyWeightCalculator.js';

/**
 * Extracts dependencies from Aura .cmp markup: controller="ClassName", provider="ClassName".
 */
export class AuraParser {
  /** Match controller="ClassName" or controller='ClassName' or controller = "ClassName" */
  private static readonly CONTROLLER =
    /controller\s*=\s*["']([A-Za-z0-9_]+)["']/gi;
  /** Match provider="ClassName" */
  private static readonly PROVIDER =
    /provider\s*=\s*["']([A-Za-z0-9_]+)["']/gi;

  /**
   * Parse Aura .cmp file and return dependencies to Apex controller/provider classes.
   * componentId must be the full id e.g. AuraComponent:myCmp
   */
  parse(filePath: string, componentId: string, isApexClass?: (name: string) => boolean): Dependency[] {
    const dependencies: Dependency[] = [];
    const seenApex = new Set<string>();

    try {
      const content = readFileSync(filePath, 'utf-8');

      for (const regex of [AuraParser.CONTROLLER, AuraParser.PROVIDER]) {
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(content)) !== null) {
          const apexClassName = match[1];
          if (!seenApex.has(apexClassName) && (!isApexClass || isApexClass(apexClassName))) {
            seenApex.add(apexClassName);
            const dep: Dependency = {
              from: componentId,
              to: `ApexClass:${apexClassName}`,
              type: 'uses',
              metadata: { source: 'aura_controller' },
            };
            dep.weight = DependencyWeightCalculator.calculate(dep);
            dependencies.push(dep);
          }
        }
      }
    } catch {
      // File read error: return no dependencies
    }

    return dependencies;
  }
}
