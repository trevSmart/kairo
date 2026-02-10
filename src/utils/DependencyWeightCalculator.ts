import type { Dependency } from '../types.js';

/**
 * Calculates the weight of a dependency based on its business process significance.
 *
 * Scale:
 * 10 = Critical business process indicator (Flow → Apex)
 * 9  = Process data manipulation (Flow → CustomObject)
 * 8  = Trigger handler pattern (Trigger → Apex)
 * 7  = Process invocation from code (Apex → Flow)
 * 6  = Data model relationships (CustomObject → CustomObject)
 * 5  = Code collaboration (Apex → Apex)
 * 3  = Trigger on object (Trigger → CustomObject)
 * 2  = Routine database operations (Apex → CustomObject via SOQL/DML)
 * 1  = Technical infrastructure (Apex → CustomObject type reference)
 */
export class DependencyWeightCalculator {
  /**
   * Calculates the weight for a dependency based on source, target, and relationship context.
   */
  static calculate(dependency: Dependency): number {
    const fromType = this.extractType(dependency.from);
    const toType = this.extractType(dependency.to);
    const source = dependency.metadata?.source as string | undefined;

    // Flow relationships (business processes!)
    if (fromType === 'Flow' && toType === 'ApexClass') {
      return 10; // Flow invoking Apex = clear business process
    }
    if (fromType === 'Flow' && toType === 'CustomObject') {
      return 9; // Flow manipulating data = business process logic
    }
    if (fromType === 'ApexClass' && toType === 'Flow') {
      return 7; // Code invoking flows = process orchestration
    }

    // Lightning (LWC / Aura) calling Apex = UI → server, strong business process
    if ((fromType === 'LightningWebComponent' || fromType === 'AuraComponent') && toType === 'ApexClass') {
      return 8; // UI invoking Apex = business logic
    }

    // Trigger patterns (often business logic)
    if (fromType === 'ApexTrigger' && toType === 'ApexClass') {
      return 8; // Trigger handler pattern = business logic
    }
    if (fromType === 'ApexTrigger' && toType === 'CustomObject' && dependency.type === 'triggers_on') {
      return 3; // Just declaring what object the trigger is on
    }

    // Data model relationships
    if (fromType === 'CustomObject' && toType === 'CustomObject') {
      return 6; // Object relationships = data model structure
    }

    // Apex to Apex (code collaboration)
    if (fromType === 'ApexClass' && toType === 'ApexClass') {
      return 5; // Class using another class
    }

    // Apex to CustomObject (distinguish by usage type)
    if (fromType === 'ApexClass' && toType === 'CustomObject') {
      if (source === 'dml') {
        return 6; // DML = data modification = significant business logic (3x SOQL)
      }
      if (source === 'soql') {
        return 2; // SOQL = routine data reads
      }
      if (source === 'soql_or_dml') {
        return 2; // Legacy fallback
      }
      if (source === 'type_reference') {
        return 1; // Just variable declaration = infrastructure
      }
      return 2; // Default for unknown Apex → Object
    }

    // Apex trigger to CustomObject (data operations)
    if (fromType === 'ApexTrigger' && toType === 'CustomObject') {
      if (source === 'dml') {
        return 6; // DML = data modification = significant
      }
      if (source === 'soql') {
        return 2; // SOQL = routine reads
      }
      if (source === 'soql_or_dml') {
        return 2; // Legacy fallback
      }
      if (source === 'type_reference') {
        return 1;
      }
      return 2;
    }

    // Default weights for other combinations
    return 3;
  }

  /**
   * Extracts the type from a component ID (format: "Type:Name")
   */
  private static extractType(componentId: string): string {
    const [type] = componentId.split(':');
    return type || 'Unknown';
  }

  /**
   * Determines if a dependency is process-significant (weight >= 7)
   */
  static isProcessSignificant(dependency: Dependency): boolean {
    return (dependency.weight ?? this.calculate(dependency)) >= 7;
  }

  /**
   * Categorizes a dependency weight into a human-readable category
   */
  static categorize(weight: number): string {
    if (weight >= 9) return 'Critical Process';
    if (weight >= 7) return 'Business Logic';
    if (weight >= 5) return 'Code Structure';
    if (weight >= 3) return 'Data Operations';
    return 'Infrastructure';
  }
}
