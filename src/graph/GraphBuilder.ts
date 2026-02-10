import Graph from 'graphology';
import type { MetadataComponent, Dependency, MetadataGraph } from '../types.js';

export class GraphBuilder {
  private graph: Graph;

  constructor() {
    this.graph = new Graph({ multi: true, type: 'directed' });
  }

  addComponent(component: MetadataComponent): void {
    if (!this.graph.hasNode(component.id)) {
      this.graph.addNode(component.id, {
        name: component.name,
        type: component.type,
        filePath: component.filePath,
        label: component.label,
        description: component.description,
      });
    }
  }

  addDependency(dependency: Dependency): void {
    // Ensure both nodes exist - extract type from ID if needed
    if (!this.graph.hasNode(dependency.from)) {
      const [type, name] = dependency.from.split(':');
      this.graph.addNode(dependency.from, {
        name: name || dependency.from,
        type: type || 'Unknown',
      });
    }
    if (!this.graph.hasNode(dependency.to)) {
      const [type, name] = dependency.to.split(':');
      this.graph.addNode(dependency.to, {
        name: name || dependency.to,
        type: type || 'Unknown',
      });
    }

    // Add edge
    this.graph.addDirectedEdge(dependency.from, dependency.to, {
      type: dependency.type,
      metadata: dependency.metadata,
      weight: dependency.weight,
    });
  }

  build(): MetadataGraph {
    const components = new Map<string, MetadataComponent>();

    this.graph.forEachNode((node, attrs) => {
      components.set(node, {
        id: node,
        name: attrs.name,
        type: attrs.type,
        filePath: attrs.filePath,
        label: attrs.label,
        description: attrs.description,
      });
    });

    const dependencies: Dependency[] = [];
    this.graph.forEachEdge((edge, attrs, source, target) => {
      dependencies.push({
        from: source,
        to: target,
        type: attrs.type,
        metadata: attrs.metadata,
        weight: attrs.weight,
      });
    });

    return { components, dependencies };
  }

  getGraph(): Graph {
    return this.graph;
  }
}
