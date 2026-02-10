/**
 * Core types for Kairo metadata analysis
 */

export type MetadataType =
  | 'CustomObject'
  | 'CustomField'
  | 'ApexClass'
  | 'ApexTrigger'
  | 'Flow'
  | 'ValidationRule'
  | 'Layout'
  | 'PermissionSet'
  | 'Profile'
  | 'LightningWebComponent'
  | 'AuraComponent';

export type DependencyType =
  | 'uses'
  | 'references'
  | 'triggers_on'
  | 'contains'
  | 'extends'
  | 'implements';

export interface MetadataComponent {
  id: string; // Unique identifier
  name: string; // API name
  type: MetadataType;
  filePath: string; // Original file path
  label?: string; // Human-readable label
  description?: string;
  namespace?: string;
}

export interface Dependency {
  from: string; // Component ID
  to: string; // Component ID
  type: DependencyType;
  weight?: number; // 0-10: significance for business processes (10 = critical process, 1 = technical infrastructure)
  metadata?: Record<string, unknown>; // Additional context
}

export interface MetadataGraph {
  components: Map<string, MetadataComponent>;
  dependencies: Dependency[];
}

export interface AnalysisResult {
  graph: MetadataGraph;
  stats: {
    totalComponents: number;
    componentsByType: Record<MetadataType, number>;
    totalDependencies: number;
  };
}
