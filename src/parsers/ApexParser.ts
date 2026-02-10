import { readFileSync } from 'fs';
import type { MetadataComponent, Dependency } from '../types.js';
import { DependencyWeightCalculator } from '../utils/DependencyWeightCalculator.js';

export interface ParsedApex {
  component: MetadataComponent;
  dependencies: Dependency[];
}

export class ApexParser {
  parse(
    filePath: string,
    type: 'ApexClass' | 'ApexTrigger',
    objectNameResolver?: (name: string) => string,
    isObjectName?: (name: string) => boolean,
    isApexClass?: (name: string) => boolean
  ): ParsedApex {
    const content = readFileSync(filePath, 'utf-8');

    // Extract class/trigger name from file path
    const fileName = filePath.split('/').pop()!;
    const name = fileName.replace(/\.(cls|trigger)$/, '');

    const component: MetadataComponent = {
      id: `${type}:${name}`,
      name,
      type,
      filePath,
    };

    const dependencies: Dependency[] = [];

    // Track objects and their operation types separately
    const objectOperations = new Map<string, Set<string>>();

    // Extract DML operations (data modifications - HIGH significance)
    const dmlPattern = /(?:INSERT|UPDATE|DELETE|UPSERT)\s+([A-Z][a-zA-Z0-9_]*__[cm]|Account|Contact|Opportunity|Case|Lead)/gi;
    let match;
    while ((match = dmlPattern.exec(content)) !== null) {
      const objectName = objectNameResolver ? objectNameResolver(match[1]) : match[1];
      if (!objectOperations.has(objectName)) {
        objectOperations.set(objectName, new Set());
      }
      objectOperations.get(objectName)!.add('dml');
    }

    // Extract SOQL queries (data reads - LOWER significance)
    const soqlPattern = /FROM\s+([A-Z][a-zA-Z0-9_]*__[cm]|Account|Contact|Opportunity|Case|Lead)/gi;
    while ((match = soqlPattern.exec(content)) !== null) {
      const objectName = objectNameResolver ? objectNameResolver(match[1]) : match[1];
      if (!objectOperations.has(objectName)) {
        objectOperations.set(objectName, new Set());
      }
      objectOperations.get(objectName)!.add('soql');
    }

    // Create dependencies with appropriate source metadata
    for (const [objectName, operations] of objectOperations.entries()) {
      // If object has DML operations, prioritize that
      const source = operations.has('dml') ? 'dml' : 'soql';

      const dep: Dependency = {
        from: component.id,
        to: `CustomObject:${objectName}`,
        type: 'uses',
        metadata: { source },
      };
      dep.weight = DependencyWeightCalculator.calculate(dep);
      dependencies.push(dep);
    }

    // Extract Custom Object/Metadata Type references (declarations, type annotations)
    // Matches: List<Type__c>, Map<K,Type__c>, new Type__c(), Type__c varName - but NOT field names in SOQL SELECT lists.
    // - (?<!\.) = not after dot (excludes record.Field__c)
    // - (?=>|\s*\(|\s+[a-z]) = only when followed by ">" (generic), "(" (constructor), or " varName" (type in declaration)
    //   so we exclude "CSP_Date4__c FROM" and "Id,CSP_Date4__c," (SELECT list fields)
    const typePattern = /(?<!\.)\b([A-Z][a-zA-Z0-9_]*__(?:c|mdt))\b(?=>|[ \t]*\(|[ \t]+[a-z])/g;
    const soqlKeywords = new Set(['from', 'where', 'order', 'group', 'limit', 'offset', 'having']);
    const foundTypeReferences = new Set<string>();
    while ((match = typePattern.exec(content)) !== null) {
      const objectName = objectNameResolver ? objectNameResolver(match[1]) : match[1];
      const after = content.slice(match.index + match[0].length);
      const afterClean = after.replace(/^[\s,]+/, '');
      const nextWordMatch = afterClean.match(/^([A-Za-z]+)/);
      if (nextWordMatch && soqlKeywords.has(nextWordMatch[1].toLowerCase())) {
        continue; // Skip SOQL SELECT list fields like "Field__c from"
      }
      // Skip if already tracked via SOQL/DML
      if (!objectOperations.has(objectName) && !foundTypeReferences.has(objectName)) {
        foundTypeReferences.add(objectName);
        const dep: Dependency = {
          from: component.id,
          to: `CustomObject:${objectName}`,
          type: 'references',
          metadata: {
            source: 'type_reference',
          },
        };
        dep.weight = DependencyWeightCalculator.calculate(dep);
        dependencies.push(dep);
      }
    }

    // Extract class references (simplified - doesn't handle all cases)
    const classPattern = /new\s+([A-Z][a-zA-Z0-9_]*)\s*\(/g;
    const foundClasses = new Set<string>();
    const standardClasses = ['String', 'Integer', 'List', 'Set', 'Map', 'Date', 'Datetime', 'Boolean', 'Decimal', 'Long', 'Double'];

    while ((match = classPattern.exec(content)) !== null) {
      const className = match[1];
      // Skip standard classes and avoid duplicates
      if (!standardClasses.includes(className) && !foundClasses.has(className)) {
        foundClasses.add(className);
        // Treat sObject instantiations as CustomObject, not ApexClass
        if (isObjectName && isObjectName(className)) {
          const resolved = objectNameResolver ? objectNameResolver(className) : className;
          const dep: Dependency = {
            from: component.id,
            to: `CustomObject:${resolved}`,
            type: 'uses',
            metadata: {
              source: 'sobject_instantiation',
            },
          };
          dep.weight = DependencyWeightCalculator.calculate(dep);
          dependencies.push(dep);
        } else if (!isApexClass || isApexClass(className)) {
          const dep: Dependency = {
            from: component.id,
            to: `ApexClass:${className}`,
            type: 'uses',
            metadata: {
              source: 'instantiation',
            },
          };
          dep.weight = DependencyWeightCalculator.calculate(dep);
          dependencies.push(dep);
        }
      }
    }

    // For triggers, extract the object they're on
    if (type === 'ApexTrigger') {
      const triggerPattern = /trigger\s+\w+\s+on\s+([A-Z][a-zA-Z0-9_]*)/;
      const triggerMatch = content.match(triggerPattern);
      if (triggerMatch) {
        const triggerObject = objectNameResolver ? objectNameResolver(triggerMatch[1]) : triggerMatch[1];
        const dep: Dependency = {
          from: component.id,
          to: `CustomObject:${triggerObject}`,
          type: 'triggers_on',
        };
        dep.weight = DependencyWeightCalculator.calculate(dep);
        dependencies.push(dep);
      }
    }

    return { component, dependencies };
  }
}
