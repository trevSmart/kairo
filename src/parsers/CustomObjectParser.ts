import { XMLParser } from 'fast-xml-parser';
import { readFileSync } from 'fs';
import type { MetadataComponent, Dependency } from '../types.js';
import { DependencyWeightCalculator } from '../utils/DependencyWeightCalculator.js';

export interface ParsedCustomObject {
  component: MetadataComponent;
  dependencies: Dependency[];
}

interface CustomObjectXML {
  CustomObject: {
    label?: string;
    description?: string;
    fields?: Array<{
      fullName: string;
      type?: string;
      referenceTo?: string | string[];
      formula?: string;
    }> | {
      fullName: string;
      type?: string;
      referenceTo?: string | string[];
      formula?: string;
    };
    validationRules?: Array<{
      fullName: string;
      errorConditionFormula?: string;
    }> | {
      fullName: string;
      errorConditionFormula?: string;
    };
  };
}

export class CustomObjectParser {
  private parser: XMLParser;

  constructor() {
    this.parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
    });
  }

  parse(filePath: string): ParsedCustomObject {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = this.parser.parse(content) as CustomObjectXML;
    const obj = parsed.CustomObject;

    // Extract object name from file path
    // e.g., test-data/main/default/objects/Account/Account.object-meta.xml -> Account
    const objectName = filePath.split('/').slice(-2, -1)[0];

    const component: MetadataComponent = {
      id: `CustomObject:${objectName}`,
      name: objectName,
      type: 'CustomObject',
      filePath,
      label: obj.label,
      description: obj.description,
    };

    const dependencies: Dependency[] = [];

    // Extract lookup/master-detail relationships
    const fields = Array.isArray(obj.fields) ? obj.fields : obj.fields ? [obj.fields] : [];

    for (const field of fields) {
      if (field.type === 'Lookup' || field.type === 'MasterDetail') {
        const referenceTo = Array.isArray(field.referenceTo)
          ? field.referenceTo
          : field.referenceTo ? [field.referenceTo] : [];

        for (const refObject of referenceTo) {
          const dep: Dependency = {
            from: component.id,
            to: `CustomObject:${refObject}`,
            type: 'references',
            metadata: {
              fieldName: field.fullName,
              relationshipType: field.type,
            },
          };
          dep.weight = DependencyWeightCalculator.calculate(dep);
          dependencies.push(dep);
        }
      }

      // Extract formula field references (simplified - real formulas need more parsing)
      if (field.formula) {
        // Basic extraction: find object references like Account.Name
        const objectRefs = field.formula.match(/\b([A-Z][a-z_]*__c|Account|Contact|Opportunity)\b/g);
        if (objectRefs) {
          for (const ref of new Set(objectRefs)) {
            const dep: Dependency = {
              from: component.id,
              to: `CustomObject:${ref}`,
              type: 'references',
              metadata: {
                fieldName: field.fullName,
                source: 'formula',
              },
            };
            dep.weight = DependencyWeightCalculator.calculate(dep);
            dependencies.push(dep);
          }
        }
      }
    }

    return { component, dependencies };
  }
}
