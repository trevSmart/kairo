import { readFileSync } from 'fs';
import type { Dependency } from '../types.js';
import { DependencyWeightCalculator } from '../utils/DependencyWeightCalculator.js';

/**
 * Extracts dependencies from LWC JavaScript: @salesforce/apex/ClassName.methodName
 * and optionally @salesforce/schema/ObjectName (for CustomObject references).
 */
export class LWCParser {
  /** Match import from '@salesforce/apex/ClassName.methodName' or "@salesforce/apex/ClassName.methodName" */
  private static readonly APEX_IMPORT =
    /from\s+['"]@salesforce\/apex\/([A-Za-z0-9_]+)\./g;

  /**
   * Parse LWC .js file and return dependencies to Apex classes (and optionally CustomObjects).
   * componentId must be the full id e.g. LightningWebComponent:myComponent
   */
  parse(filePath: string, componentId: string): Dependency[] {
    const dependencies: Dependency[] = [];
    const seenApex = new Set<string>();

    try {
      const content = readFileSync(filePath, 'utf-8');
      let match: RegExpExecArray | null;
      LWCParser.APEX_IMPORT.lastIndex = 0;
      while ((match = LWCParser.APEX_IMPORT.exec(content)) !== null) {
        const apexClassName = match[1];
        if (!seenApex.has(apexClassName)) {
          seenApex.add(apexClassName);
          const dep: Dependency = {
            from: componentId,
            to: `ApexClass:${apexClassName}`,
            type: 'uses',
            metadata: { source: 'lwc_apex_import' },
          };
          dep.weight = DependencyWeightCalculator.calculate(dep);
          dependencies.push(dep);
        }
      }
    } catch {
      // File read error: return no dependencies
    }

    return dependencies;
  }
}
