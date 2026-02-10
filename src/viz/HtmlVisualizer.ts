import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import type { AnalysisResult, Dependency } from '../types.js';
import { DependencyWeightCalculator } from '../utils/DependencyWeightCalculator.js';

type NodeInput = { id: string; label: string; type: string; name: string };
type EdgeInput = { from: string; to: string; label: string; weight: number };
type VisNode = {
  id: string;
  label: string;
  fullLabel: string;
  title: string;
  color: string;
  font: { size: number; color: string };
  shape: string;
  size: number;
  metadata: NodeInput;
};
type VisEdge = {
  id: number;
  from: string;
  to: string;
  arrows: string;
  color: { color: string; opacity: number };
  width: number;
  length: number;
  title?: string;
  weight: number;
  fidelity: number;
};

const COLOR_MAP: Record<string, string> = {
  CustomObject: '#4CAF50',
  ApexClass: '#2196F3',
  ApexTrigger: '#FF9800',
  Flow: '#9C27B0',
  LightningWebComponent: '#E91E63',
  AuraComponent: '#E91E63',
};

const FIDELITY_PULL = 0.5;

type DegreeStats = {
  degree: Map<string, number>;
  median: number;
  p95: number;
  p99: number;
  nodeCount: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const idx = Math.max(0, Math.min(values.length - 1, Math.floor(p * (values.length - 1))));
  return values[idx];
}

function describeWeight(minWeight: number): string {
  const descriptions: Record<number, string> = {
    0: 'Showing all dependencies',
    1: 'Hiding infrastructure references',
    3: 'Data operations and above',
    5: 'Code structure and above',
    7: 'Business logic only',
    9: 'Critical processes only',
  };
  return descriptions[minWeight] || `Weight >= ${minWeight}`;
}

function computeRecommendedFilters(edges: EdgeInput[]): { minWeight: number; minConnections: number } {
  const weights = edges.map(e => e.weight || 0).sort((a, b) => a - b);
  if (weights.length === 0) return { minWeight: 0, minConnections: 1 };

  let minWeight = percentile(weights, 0.85);
  let filtered = edges.filter(e => (e.weight || 0) >= minWeight);
  if (filtered.length < Math.max(10, Math.floor(edges.length * 0.05))) {
    minWeight = percentile(weights, 0.7);
    filtered = edges.filter(e => (e.weight || 0) >= minWeight);
  }
  minWeight = clamp(Math.round(minWeight), 0, 10);

  const degree = new Map<string, number>();
  for (const e of filtered) {
    degree.set(e.from, (degree.get(e.from) || 0) + 1);
    degree.set(e.to, (degree.get(e.to) || 0) + 1);
  }
  const degrees = Array.from(degree.values()).sort((a, b) => a - b);
  const minConnections = Math.max(1, Math.floor(percentile(degrees, 0.5) || 1));

  return { minWeight, minConnections };
}

function computeDegreeStats(deps: Dependency[]): DegreeStats {
  const degree = new Map<string, number>();
  for (const d of deps) {
    degree.set(d.from, (degree.get(d.from) || 0) + 1);
    degree.set(d.to, (degree.get(d.to) || 0) + 1);
  }
  const values = Array.from(degree.values()).sort((a, b) => a - b);
  const nodeCount = values.length || 1;
  const at = (p: number) => values[Math.floor(p * (values.length - 1))] ?? 1;
  return {
    degree,
    median: at(0.5) || 1,
    p95: at(0.95) || 1,
    p99: at(0.99) || 1,
    nodeCount,
  };
}

function baseWeight(dep: Dependency): number {
  return dep.weight ?? DependencyWeightCalculator.calculate(dep);
}

function tuneWeight(dep: Dependency, stats: DegreeStats): number {
  let w = baseWeight(dep);
  const fromType = dep.from.split(':')[0] || 'Unknown';
  const toType = dep.to.split(':')[0] || 'Unknown';
  const source = (dep.metadata as Record<string, unknown> | undefined)?.source as string | undefined;

  // Down-weight low-signal edges (observed majority in dataset)
  if (source === 'type_reference') w *= 0.35; // Very noisy
  if (source === 'soql') w *= 0.6; // Data reads: weaker signal
  if (source === 'dml') w = Math.max(w, 7.5); // Data mutation: process signal

  // Promote UI/trigger → Apex as strong process signals
  if ((fromType === 'LightningWebComponent' || fromType === 'AuraComponent') && toType === 'ApexClass') {
    w = Math.max(w, 9);
  }
  if (fromType === 'ApexTrigger' && toType === 'ApexClass') {
    w = Math.max(w, 9);
  }

  // Penalize hub targets for low/medium signal edges (based on dataset degree distribution)
  const targetDeg = stats.degree.get(dep.to) || 1;
  if (w < 7) {
    const idf = Math.log(1 + stats.nodeCount / targetDeg) / Math.log(1 + stats.nodeCount / stats.median);
    w *= clamp(idf, 0.35, 1.2);
    if (targetDeg >= stats.p99) w *= 0.6;
    else if (targetDeg >= stats.p95) w *= 0.8;
  }

  return clamp(w, 0.2, 10);
}

function buildVisData(
  nodes: NodeInput[],
  edges: EdgeInput[]
): { visNodes: VisNode[]; visEdges: VisEdge[] } {
  const connectionCounts = new Map<string, number>();
  for (const e of edges) {
    connectionCounts.set(e.from, (connectionCounts.get(e.from) || 0) + 1);
    connectionCounts.set(e.to, (connectionCounts.get(e.to) || 0) + 1);
  }
  function edgeFidelity(fromId: string, toId: string): number {
    const degFrom = Math.max(1, connectionCounts.get(fromId) || 0);
    const degTo = Math.max(1, connectionCounts.get(toId) || 0);
    return Math.min(1, 1 / Math.sqrt(degFrom * degTo));
  }
  function calcSpringLength(weight: number): number {
    const weakThreshold = 5;
    if (weight >= weakThreshold) {
      const factor = 10 - weight;
      return Math.max(25, 25 + factor * 15);
    }
    const baseSeparation = 200;
    const repulsionMultiplier = 1;
    const weightFactor = (weakThreshold - weight) / weakThreshold;
    return baseSeparation + weightFactor * 400 * repulsionMultiplier;
  }
  const visNodes: VisNode[] = nodes.map(node => {
    const connections = connectionCounts.get(node.id) || 0;
    const baseSize = node.type === 'CustomObject' ? 10 : 15;
    // Strongly scale CustomObject by number of relations; Apex/LWC/Aura/Flow keep fixed size
    const scaleFactor =
      node.type === 'CustomObject' ? Math.min(1 + Math.sqrt(connections) * 0.8, 8) : 1;
    const nodeSize = baseSize * scaleFactor;
    return {
      id: node.id,
      label: '',
      fullLabel: node.name,
      title: String(node.label || node.name || node.id || node.type || ''),
      color: COLOR_MAP[node.type] || '#999',
      font: { size: 12, color: '#333' },
      shape: 'dot',
      size: nodeSize,
      metadata: node,
    };
  });
  const visEdges: VisEdge[] = edges.map((edge, i) => {
    const weight = edge.weight || 3;
    const fidelity = edgeFidelity(edge.from, edge.to);
    const fidelityBoost = 1 + fidelity * 0.4;
    const width = Math.max(0.5, (weight / 2) * fidelityBoost);
    const opacity = Math.max(0.2, Math.min(1, (weight / 10) * fidelityBoost));
    const baseSpringLength = calcSpringLength(weight);
    const springLength = baseSpringLength * (1 - fidelity * FIDELITY_PULL);
    let color = '#ccc';
    if (weight >= 9) color = '#E91E63';
    else if (weight >= 7) color = '#9C27B0';
    else if (weight >= 5) color = '#2196F3';
    else if (weight >= 3) color = '#757575';
    return {
      id: i,
      from: edge.from,
      to: edge.to,
      arrows: 'to',
      color: { color, opacity },
      width,
      length: springLength,
      weight,
      fidelity,
    };
  });
  return { visNodes, visEdges };
}

export class HtmlVisualizer {
  generate(result: AnalysisResult, outputPath: string): void {
    // Ensure output directory exists
    const dir = dirname(outputPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const { nodes, edges } = this.buildNodesAndEdges(result);
    const recommended = computeRecommendedFilters(edges);
    const html = this.generateHtml(nodes, edges, result.stats, recommended);
    writeFileSync(outputPath, html);
    console.log(`📊 Visualization saved to: ${outputPath}`);
  }

  /** Build nodes and edges from AnalysisResult (same logic as generate). */
  private buildNodesAndEdges(result: AnalysisResult): { nodes: NodeInput[]; edges: EdgeInput[] } {
    const nodes: NodeInput[] = Array.from(result.graph.components.values()).map(comp => ({
      id: comp.id,
      label: comp.label || comp.name,
      type: comp.type,
      name: comp.name,
    }));
    const stats = computeDegreeStats(result.graph.dependencies);
    const edgeMap = new Map<string, { from: string; to: string; label: string; weight: number; count: number; maxWeight: number }>();
    result.graph.dependencies.forEach(dep => {
      const key = `${dep.from}->${dep.to}`;
      const tuned = tuneWeight(dep, stats);
      const existing = edgeMap.get(key);
      if (existing) {
        existing.count += 1;
        existing.weight += tuned;
        existing.maxWeight = Math.max(existing.maxWeight, tuned);
      } else {
        edgeMap.set(key, {
          from: dep.from,
          to: dep.to,
          label: dep.type,
          weight: tuned,
          count: 1,
          maxWeight: tuned,
        });
      }
    });
    const edges: EdgeInput[] = Array.from(edgeMap.values()).map(edge => {
      const fromType = edge.from.split(':')[0];
      const toType = edge.to.split(':')[0];

      // Non-linear boost for multiple references (rare in this dataset but improves signal)
      const countBoost = Math.log1p(edge.count) * 0.7;
      let finalWeight = Math.min(10, edge.maxWeight + countBoost);

      // Preserve existing Apex->Apex collaboration weighting behavior
      if (fromType === 'ApexClass' && toType === 'ApexClass') {
        const countFactor = Math.sqrt(edge.count);
        finalWeight = Math.min(10, Math.max(finalWeight, 4 + countFactor));
      }

      return {
        from: edge.from,
        to: edge.to,
        label: edge.count > 1 ? `${edge.label} (×${edge.count})` : edge.label,
        weight: finalWeight,
      };
    });
    return { nodes, edges };
  }

  generateMultiDataset(
    datasets: Array<{ id: string; name: string; result: AnalysisResult }>,
    outputPath: string
  ): void {
    const dir = dirname(outputPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const payloads = datasets.map(({ id, name, result }) => {
      const { nodes, edges } = this.buildNodesAndEdges(result);
      const { visNodes, visEdges } = buildVisData(nodes, edges);
      const recommended = computeRecommendedFilters(edges);
      return { id, name, stats: result.stats, nodes, visNodes, visEdges, recommended };
    });
    const html = this.generateHtmlMulti(payloads);
    writeFileSync(outputPath, html);
    console.log(`📊 Multi-dataset visualization saved to: ${outputPath}`);
  }

  private generateHtml(
    nodes: Array<{ id: string; label: string; type: string; name: string }>,
    edges: Array<{ from: string; to: string; label: string; weight: number }>,
    stats: AnalysisResult['stats'],
    recommended: { minWeight: number; minConnections: number }
  ): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Kairo - Salesforce Metadata Analysis</title>
  <script src="https://unpkg.com/vis-network@9.1.2/standalone/umd/vis-network.min.js"></script>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
    #header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 20px 30px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }
    h1 {
      margin: 0 0 10px 0;
      font-size: 28px;
    }
    #stats {
      display: flex;
      gap: 30px;
      font-size: 14px;
      opacity: 0.9;
    }
    .stat {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .stat-value {
      font-size: 20px;
      font-weight: bold;
    }
    #graph {
      flex: 1;
      background: #f5f5f5;
      position: relative;
      min-height: 0;
      /* GPU acceleration for smoother rendering */
      transform: translateZ(0);
      will-change: transform;
    }
    #graph canvas {
      /* Optimize canvas rendering */
      image-rendering: -webkit-optimize-contrast;
      image-rendering: crisp-edges;
    }
    #info-panel {
      position: absolute;
      top: 100px;
      right: 20px;
      background: white;
      border-radius: 8px;
      padding: 15px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.15);
      max-width: 300px;
      display: none;
    }
    #info-panel.visible {
      display: block;
    }
    .info-title {
      font-weight: bold;
      font-size: 16px;
      margin-bottom: 10px;
      color: #667eea;
    }
    .info-row {
      margin: 5px 0;
      font-size: 14px;
    }
    .info-label {
      color: #666;
      font-size: 12px;
    }
    .legend {
      position: absolute;
      bottom: 20px;
      right: 20px;
      background: white;
      border-radius: 8px;
      padding: 15px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.15);
    }
    .legend-title {
      font-weight: bold;
      margin-bottom: 10px;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 5px 0;
      font-size: 14px;
    }
    .legend-color {
      width: 16px;
      height: 16px;
      border-radius: 50%;
    }
    #controls {
      position: absolute;
      top: 100px;
      left: 20px;
      background: white;
      border-radius: 8px;
      padding: 15px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.15);
      min-width: 250px;
    }
    .control-section {
      margin-bottom: 15px;
    }
    .control-label {
      font-weight: bold;
      margin-bottom: 8px;
      display: block;
      font-size: 14px;
    }
    .checkbox-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .checkbox-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
    }
    input[type="checkbox"] {
      cursor: pointer;
    }
    input[type="text"] {
      width: 100%;
      padding: 8px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 13px;
    }
    button {
      width: 100%;
      padding: 8px;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      margin-top: 8px;
    }
    button:hover {
      background: #5568d3;
    }
    div.vis-tooltip {
      position: absolute;
      visibility: hidden;
      padding: 6px 10px;
      white-space: nowrap;
      color: #333;
      background: #fff;
      border-radius: 6px;
      border: 1px solid #ccc;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      pointer-events: none;
      z-index: 1000;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div id="header">
    <h1>🎯 Kairo - Salesforce Metadata Dependency Graph</h1>
    <div id="stats">
      <div class="stat">
        <span>Total Components:</span>
        <span class="stat-value">${stats.totalComponents}</span>
      </div>
      <div class="stat">
        <span>Dependencies:</span>
        <span class="stat-value">${stats.totalDependencies}</span>
      </div>
      <div class="stat">
        <span>Objects:</span>
        <span class="stat-value">${stats.componentsByType.CustomObject || 0}</span>
      </div>
      <div class="stat">
        <span>Apex Classes:</span>
        <span class="stat-value">${stats.componentsByType.ApexClass || 0}</span>
      </div>
      <div class="stat">
        <span>Triggers:</span>
        <span class="stat-value">${stats.componentsByType.ApexTrigger || 0}</span>
      </div>
      <div class="stat">
        <span>LWC:</span>
        <span class="stat-value">${stats.componentsByType.LightningWebComponent || 0}</span>
      </div>
      <div class="stat">
        <span>Aura:</span>
        <span class="stat-value">${stats.componentsByType.AuraComponent || 0}</span>
      </div>
    </div>
  </div>

  <div id="graph"></div>

  <div id="controls">
    <div class="control-section">
      <label class="control-label">Search Component</label>
      <input type="text" id="search-input" placeholder="Type to filter nodes...">
      <button onclick="resetView()">Reset View</button>
      <button onclick="applyRecommended()">Auto Focus</button>
    </div>

    <div class="control-section">
      <label class="control-label">Filter by Type</label>
      <div class="checkbox-group">
        <label class="checkbox-item">
          <input type="checkbox" value="CustomObject" checked onchange="filterByType()"> Objects
        </label>
        <label class="checkbox-item">
          <input type="checkbox" value="ApexClass" checked onchange="filterByType()"> Apex Classes
        </label>
        <label class="checkbox-item">
          <input type="checkbox" value="ApexTrigger" checked onchange="filterByType()"> Triggers
        </label>
        <label class="checkbox-item">
          <input type="checkbox" value="Flow" checked onchange="filterByType()"> Flows
        </label>
        <label class="checkbox-item">
          <input type="checkbox" value="LightningWebComponent" checked onchange="filterByType()"> LWC
        </label>
        <label class="checkbox-item">
          <input type="checkbox" value="AuraComponent" checked onchange="filterByType()"> Aura
        </label>
      </div>
    </div>

    <div class="control-section">
      <label class="control-label">Min Connections</label>
      <input type="range" id="min-connections" min="0" max="20" value="${recommended.minConnections}" onchange="filterByConnections(this.value)">
      <span id="connections-value">${recommended.minConnections}</span>
    </div>

    <div class="control-section">
      <label class="control-label">Dependency Weight Filter</label>
      <input type="range" id="min-weight" min="0" max="10" value="${recommended.minWeight}" onchange="filterByWeight(this.value)">
      <div style="display: flex; justify-content: space-between; font-size: 11px; margin-top: 4px;">
        <span>All</span>
        <span id="weight-value">${recommended.minWeight}</span>
        <span>Process Only</span>
      </div>
      <div style="font-size: 11px; color: #666; margin-top: 4px;" id="weight-description">${describeWeight(recommended.minWeight)}</div>
    </div>

    <div class="control-section">
      <label class="control-label">Weak Relation Threshold</label>
      <input type="range" id="weak-threshold" min="1" max="10" value="5" step="0.5" onchange="updatePhysics()">
      <div style="display: flex; justify-content: space-between; font-size: 11px; margin-top: 4px;">
        <span>1</span>
        <span id="weak-threshold-value">5</span>
        <span>10</span>
      </div>
      <div style="font-size: 11px; color: #666; margin-top: 4px;">Relations below this weight are considered weak</div>
    </div>

    <div class="control-section">
      <label class="control-label">Weak Relation Repulsion</label>
      <input type="range" id="weak-repulsion" min="1" max="50" value="5" step="0.5" onchange="updatePhysics()">
      <div style="display: flex; justify-content: space-between; font-size: 11px; margin-top: 4px;">
        <span>Less</span>
        <span id="weak-repulsion-value">5</span>
        <span>50</span>
      </div>
      <div style="font-size: 11px; color: #666; margin-top: 4px;">How much weak relations repel each other</div>
    </div>
  </div>

  <div id="info-panel">
    <div class="info-title" id="info-name"></div>
    <div class="info-row"><span class="info-label">Type:</span> <span id="info-type"></span></div>
    <div class="info-row"><span class="info-label">ID:</span> <span id="info-id"></span></div>
    <div class="info-row"><span class="info-label">Dependencies:</span> <span id="info-deps"></span></div>
  </div>

  <div class="legend">
    <div class="legend-title">Component Types</div>
    <div class="legend-item">
      <div class="legend-color" style="background: #4CAF50;"></div>
      <span>Custom Object</span>
    </div>
    <div class="legend-item">
      <div class="legend-color" style="background: #2196F3;"></div>
      <span>Apex Class</span>
    </div>
    <div class="legend-item">
      <div class="legend-color" style="background: #FF9800;"></div>
      <span>Apex Trigger</span>
    </div>
    <div class="legend-item">
      <div class="legend-color" style="background: #9C27B0;"></div>
      <span>Flow</span>
    </div>
    <div class="legend-item">
      <div class="legend-color" style="background: #E91E63;"></div>
      <span>LWC / Aura</span>
    </div>
    <hr style="margin: 12px 0; border: none; border-top: 1px solid #eee;">
    <div class="legend-title">Dependency Weights</div>
    <div class="legend-item">
      <div style="width: 30px; height: 3px; background: #E91E63;"></div>
      <span style="font-size: 12px;">Critical (9-10)</span>
    </div>
    <div class="legend-item">
      <div style="width: 30px; height: 2.5px; background: #9C27B0;"></div>
      <span style="font-size: 12px;">Business (7-8)</span>
    </div>
    <div class="legend-item">
      <div style="width: 30px; height: 2px; background: #2196F3;"></div>
      <span style="font-size: 12px;">Structure (5-6)</span>
    </div>
    <div class="legend-item">
      <div style="width: 30px; height: 1px; background: #757575;"></div>
      <span style="font-size: 12px;">Operations (3-4)</span>
    </div>
    <div class="legend-item">
      <div style="width: 30px; height: 0.5px; background: #ccc;"></div>
      <span style="font-size: 12px;">Infrastructure (1-2)</span>
    </div>
  </div>

  <script>
    const nodesData = ${JSON.stringify(nodes)};
    const edgesData = ${JSON.stringify(edges)};

    const colorMap = {
      'CustomObject': '#4CAF50',
      'ApexClass': '#2196F3',
      'ApexTrigger': '#FF9800',
      'Flow': '#9C27B0',
      'LightningWebComponent': '#E91E63',
      'AuraComponent': '#E91E63',
    };

    // Count connections for each node to scale size
    const connectionCounts = new Map();
    edgesData.forEach(edge => {
      connectionCounts.set(edge.from, (connectionCounts.get(edge.from) || 0) + 1);
      connectionCounts.set(edge.to, (connectionCounts.get(edge.to) || 0) + 1);
    });

    const visNodes = nodesData.map(node => {
      const baseSize = node.type === 'CustomObject' ? 10 : 15;
      const connections = connectionCounts.get(node.id) || 0;
      // Strongly scale CustomObject by relations; Apex/LWC/Aura/Flow fixed size
      const scaleFactor = node.type === 'CustomObject' ? Math.min(1 + (Math.sqrt(connections) * 0.8), 8) : 1;
      const nodeSize = baseSize * scaleFactor;

      return {
        id: node.id,
        label: '',
        fullLabel: node.name,
        title: String(node.label || node.name || node.id || node.type || ''),
        color: colorMap[node.type] || '#999',
        font: { size: 12, color: '#333' },
        shape: 'dot',
        size: nodeSize,
        metadata: node,
      };
    });

    // Fidelity: reward exclusive relationships (nodes that connect mainly to each other).
    // fidelity = 1 when both nodes have degree 1; decreases as either node has more connections.
    const FIDELITY_PULL = 0.5; // How much to shorten spring for faithful pairs (0–1)

    function edgeFidelity(fromId, toId) {
      const degFrom = Math.max(1, connectionCounts.get(fromId) || 0);
      const degTo = Math.max(1, connectionCounts.get(toId) || 0);
      return Math.min(1, 1 / Math.sqrt(degFrom * degTo));
    }

    // Function to calculate spring length based on weight and user settings
    function calculateSpringLength(weight, weakThreshold, weakRepulsion) {
      if (weight >= weakThreshold) {
        // Strong relations: tight clusters
        const factor = 10 - weight; // 0-5 range
        return Math.max(25, 25 + (factor * 15)); // 25-100px
      } else {
        // Weak relations: use repulsion multiplier
        const baseSeparation = 200;
        const repulsionMultiplier = weakRepulsion / 5; // 0.2-2.0 range
        const weightFactor = (weakThreshold - weight) / weakThreshold; // 0-1
        return baseSeparation + (weightFactor * 400 * repulsionMultiplier); // 200-1000px
      }
    }

    // Map edge weights to visual properties AND physics
    // Weight 10 (business process) = thick, vibrant, SHORT spring (tight cluster)
    // Faithful pairs (low promiscuity) get even shorter springs and slightly thicker lines.
    const visEdges = edgesData.map((edge, i) => {
      const weight = edge.weight || 3;
      const fidelity = edgeFidelity(edge.from, edge.to);
      const fidelityBoost = 1 + fidelity * 0.4; // Slightly thicker/more visible for faithful edges
      const width = Math.max(0.5, (weight / 2) * fidelityBoost);
      const opacity = Math.max(0.2, Math.min(1, (weight / 10) * fidelityBoost));

      // Base spring length from weight; shorten for high-fidelity (exclusive) relationships
      const baseSpringLength = calculateSpringLength(weight, 5, 5);
      const springLength = baseSpringLength * (1 - fidelity * FIDELITY_PULL);

      // Color based on weight category
      let color = '#ccc'; // default gray
      if (weight >= 9) color = '#E91E63'; // Critical process = pink
      else if (weight >= 7) color = '#9C27B0'; // Business logic = purple
      else if (weight >= 5) color = '#2196F3'; // Code structure = blue
      else if (weight >= 3) color = '#757575'; // Data operations = dark gray

      return {
        id: i,
        from: edge.from,
        to: edge.to,
        arrows: 'to',
        color: { color: color, opacity: opacity },
        width: width,
        length: springLength,
        weight: weight,
        fidelity: fidelity, // For updatePhysics
      };
    });

    const container = document.getElementById('graph');

    // Create DataSets for dynamic filtering
    const nodesDataset = new vis.DataSet(visNodes);
    const edgesDataset = new vis.DataSet(visEdges);
    const data = { nodes: nodesDataset, edges: edgesDataset };

    const options = {
      autoResize: false,
      physics: {
        enabled: true,
        barnesHut: {
          gravitationalConstant: -5000, // Strong repulsion to separate islands
          centralGravity: 0.03, // Very low center pull
          springLength: 150, // Default spring length (overridden per-edge)
          springConstant: 0.005, // Weaker springs for more separation
          avoidOverlap: 0.5, // Better overlap avoidance
          damping: 0.5, // Higher damping for faster stabilization
        },
        stabilization: {
          enabled: true,
          iterations: 250, // Enough iterations
          updateInterval: 10, // Fast updates for better performance
        },
        solver: 'barnesHut',
        timestep: 0.5,
        adaptiveTimestep: true,
      },
      rendering: {
        // Enable hardware acceleration and performance optimizations
        improvedLayout: true,
        hideEdgesOnDrag: false, // Keep visible but could hide for better performance
        hideEdgesOnZoom: false,
        hideNodesOnDrag: false,
      },
      interaction: {
        hover: true,
        tooltipDelay: 100,
        navigationButtons: true,
        keyboard: true,
        zoomView: true,
        dragView: true,
      },
      nodes: {
        shape: 'dot',
        // size removed - using individual node sizes based on connections
        font: {
          size: 12,
          color: '#333',
        },
        borderWidth: 2,
        borderWidthSelected: 3,
      },
      edges: {
        width: 1,
        color: { inherit: 'from' },
        smooth: {
          enabled: false, // Straight edges = better performance
        },
        arrows: {
          to: {
            enabled: true,
            scaleFactor: 0.5,
          },
        },
      },
      performance: {
        // Optimize for better framerate
        forceHidden: false,
        hiding: {
          enabled: false, // Don't hide distant nodes during zoom
        },
      },
    };

    const network = new vis.Network(container, data, options);

    // Show labels only at high zoom levels to avoid clutter
    const LABEL_ZOOM_THRESHOLD = 2.0;
    let labelsVisible = false;
    function updateLabelsForZoom(scale) {
      const shouldShow = scale >= LABEL_ZOOM_THRESHOLD;
      if (shouldShow === labelsVisible) return;
      labelsVisible = shouldShow;
      const updates = nodesDataset.get().map(n => ({
        id: n.id,
        label: shouldShow ? n.fullLabel : '',
      }));
      nodesDataset.update(updates);
    }
    network.on('zoom', function(params) {
      updateLabelsForZoom(params.scale);
    });
    updateLabelsForZoom(network.getScale());

    const SHOULD_FREEZE = visNodes.length <= 900;

    // Stop physics after stabilization completes (not just iterations done)
    network.on('stabilizationProgress', function(params) {
      const progress = Math.round((params.iterations / params.total) * 100);
      if (progress % 20 === 0) {
        console.log('Stabilizing graph...', progress + '%');
      }
    });

    if (SHOULD_FREEZE) {
      network.once('stabilized', function() {
        // Disable physics quickly after stabilization for better performance
        setTimeout(function() {
          network.setOptions({ physics: false });
          console.log('✅ Graph stabilized and physics disabled for better performance');
        }, 500);
      });
    } else {
      // Keep physics running for large graphs to avoid abrupt freezing
      network.setOptions({ physics: { enabled: true, stabilization: { enabled: false } } });
    }

    const infoPanel = document.getElementById('info-panel');
    network.on('click', function(params) {
      if (params.nodes.length > 0) {
        const nodeId = params.nodes[0];
        const node = nodesData.find(n => n.id === nodeId);
        const connectedEdges = network.getConnectedEdges(nodeId);

        document.getElementById('info-name').textContent = node.label;
        document.getElementById('info-type').textContent = node.type;
        document.getElementById('info-id').textContent = node.id;
        document.getElementById('info-deps').textContent = connectedEdges.length;

        infoPanel.classList.add('visible');
      }
    });

    network.on('click', function(params) {
      if (params.nodes.length === 0) {
        infoPanel.classList.remove('visible');
      }
    });

    console.log('📊 Graph loaded with', visNodes.length, 'nodes and', visEdges.length, 'edges');

    // Filter functions
    let allNodes = visNodes.slice();
    let allEdges = visEdges.slice();
    const DEFAULT_MIN_WEIGHT = ${recommended.minWeight};
    const DEFAULT_MIN_CONNECTIONS = ${recommended.minConnections};

    function weightDescription(value) {
      const descriptions = {
        0: 'Showing all dependencies',
        1: 'Hiding infrastructure references',
        3: 'Data operations and above',
        5: 'Code structure and above',
        7: 'Business logic only',
        9: 'Critical processes only'
      };
      return descriptions[value] || \`Weight >= \${value}\`;
    }

    function applyFilters() {
      const checkboxes = document.querySelectorAll('#controls input[type="checkbox"]');
      const selectedTypes = Array.from(checkboxes)
        .filter(cb => cb.checked)
        .map(cb => cb.value);

      const minConn = parseInt(document.getElementById('min-connections').value, 10) || 0;
      const minWeight = parseInt(document.getElementById('min-weight').value, 10) || 0;

      const typeFilteredNodes = allNodes.filter(node => selectedTypes.includes(node.metadata.type));
      const typeNodeIds = new Set(typeFilteredNodes.map(n => n.id));

      let filteredEdges = allEdges.filter(edge => (edge.weight || 3) >= minWeight);
      filteredEdges = filteredEdges.filter(edge => typeNodeIds.has(edge.from) && typeNodeIds.has(edge.to));

      const connectionCounts = new Map();
      filteredEdges.forEach(edge => {
        connectionCounts.set(edge.from, (connectionCounts.get(edge.from) || 0) + 1);
        connectionCounts.set(edge.to, (connectionCounts.get(edge.to) || 0) + 1);
      });

      const filteredNodes = typeFilteredNodes.filter(node =>
        (connectionCounts.get(node.id) || 0) >= minConn
      );
      const finalNodeIds = new Set(filteredNodes.map(n => n.id));
      filteredEdges = filteredEdges.filter(edge => finalNodeIds.has(edge.from) && finalNodeIds.has(edge.to));

      const positions = network.getPositions();
      const nodesWithPositions = filteredNodes.map(node => ({
        ...node,
        x: positions[node.id]?.x,
        y: positions[node.id]?.y,
        fixed: { x: false, y: false },
      }));

      nodesDataset.clear();
      edgesDataset.clear();
      nodesDataset.add(nodesWithPositions);
      edgesDataset.add(filteredEdges);
      updateLabelsForZoom(network.getScale());
    }

    function filterByType() {
      applyFilters();
    }

    function filterByConnections(minConnections) {
      document.getElementById('connections-value').textContent = minConnections;
      applyFilters();
    }

    function resetView() {
      const searchInput = document.getElementById('search-input');
      if (searchInput) searchInput.value = '';

      const checkboxes = document.querySelectorAll('#controls input[type="checkbox"]');
      checkboxes.forEach(cb => { cb.checked = true; });

      const minWeightEl = document.getElementById('min-weight');
      if (minWeightEl) minWeightEl.value = DEFAULT_MIN_WEIGHT;
      document.getElementById('weight-value').textContent = DEFAULT_MIN_WEIGHT;
      document.getElementById('weight-description').textContent = weightDescription(DEFAULT_MIN_WEIGHT);

      const weakThresholdEl = document.getElementById('weak-threshold');
      const weakRepulsionEl = document.getElementById('weak-repulsion');
      if (weakThresholdEl) weakThresholdEl.value = 5;
      if (weakRepulsionEl) weakRepulsionEl.value = 5;
      document.getElementById('weak-threshold-value').textContent = '5';
      document.getElementById('weak-repulsion-value').textContent = '5';

      document.getElementById('min-connections').value = DEFAULT_MIN_CONNECTIONS;
      document.getElementById('connections-value').textContent = DEFAULT_MIN_CONNECTIONS;

      applyFilters();
      network.fit();
    }

    function filterByWeight(minWeight) {
      document.getElementById('weight-value').textContent = minWeight;

      document.getElementById('weight-description').textContent = weightDescription(minWeight);
      applyFilters();
    }

    function applyRecommended() {
      const minConnEl = document.getElementById('min-connections');
      if (minConnEl) minConnEl.value = DEFAULT_MIN_CONNECTIONS;
      document.getElementById('connections-value').textContent = DEFAULT_MIN_CONNECTIONS;
      const minWeightEl = document.getElementById('min-weight');
      if (minWeightEl) minWeightEl.value = DEFAULT_MIN_WEIGHT;
      filterByWeight(DEFAULT_MIN_WEIGHT);
    }

    // Apply default filters on initial load
    applyFilters();

    // Search functionality
    const searchInput = document.getElementById('search-input');
    searchInput.addEventListener('input', function(e) {
      const searchTerm = e.target.value.toLowerCase();
      if (searchTerm.length < 2) {
        resetView();
        return;
      }

      const filteredNodes = allNodes.filter(node =>
        (node.name && node.name.toLowerCase().includes(searchTerm)) ||
        (node.title && node.title.toLowerCase().includes(searchTerm))
      );
      const nodeIds = new Set(filteredNodes.map(n => n.id));

      // Also include connected nodes
      const extendedNodeIds = new Set(nodeIds);
      allEdges.forEach(edge => {
        if (nodeIds.has(edge.from)) extendedNodeIds.add(edge.to);
        if (nodeIds.has(edge.to)) extendedNodeIds.add(edge.from);
      });

      const extendedNodes = allNodes.filter(n => extendedNodeIds.has(n.id));
      const filteredEdges = allEdges.filter(edge =>
        extendedNodeIds.has(edge.from) && extendedNodeIds.has(edge.to)
      );

      nodesDataset.clear();
      edgesDataset.clear();
      nodesDataset.add(extendedNodes);
      edgesDataset.add(filteredEdges);
      updateLabelsForZoom(network.getScale());

      if (filteredNodes.length > 0) {
        network.fit({ nodes: Array.from(nodeIds) });
      }

      console.log('Search found', filteredNodes.length, 'matching nodes, showing', extendedNodes.length, 'total');
    });

    // Update physics parameters based on sliders
    function updatePhysics() {
      const weakThreshold = parseFloat(document.getElementById('weak-threshold').value);
      const weakRepulsion = parseFloat(document.getElementById('weak-repulsion').value);

      document.getElementById('weak-threshold-value').textContent = weakThreshold.toFixed(1);
      document.getElementById('weak-repulsion-value').textContent = weakRepulsion.toFixed(1);

      // Recalculate spring lengths for all edges (weight + fidelity)
      const updatedEdges = allEdges.map(edge => {
        const weight = edge.weight || 3;
        const fidelity = edge.fidelity != null ? edge.fidelity : edgeFidelity(edge.from, edge.to);
        let springLength;

        if (weight >= weakThreshold) {
          const factor = 10 - weight;
          springLength = Math.max(25, 25 + (factor * 15));
        } else {
          const baseSeparation = 200;
          const repulsionMultiplier = weakRepulsion / 5;
          const weightFactor = (weakThreshold - weight) / weakThreshold;
          springLength = baseSeparation + (weightFactor * 400 * repulsionMultiplier);
        }
        springLength = springLength * (1 - fidelity * FIDELITY_PULL);

        return { ...edge, length: springLength };
      });

      // Update edges in dataset
      edgesDataset.clear();
      edgesDataset.add(updatedEdges);

      // Re-enable physics temporarily to apply changes
      network.setOptions({ physics: { enabled: true } });

      // Disable physics after stabilization only for smaller graphs
      if (SHOULD_FREEZE) {
        setTimeout(() => {
          network.setOptions({ physics: { enabled: false } });
        }, 5000);
      }

      console.log(\`Updated physics: threshold=\${weakThreshold}, repulsion=\${weakRepulsion}\`);
    }

    // Initial load warning and auto-filter for large graphs
    if (visNodes.length > 1000) {
      console.warn('⚠️  Large graph detected (' + visNodes.length + ' nodes). Auto-filtering to most connected components.');
      const initialMinConnections = DEFAULT_MIN_CONNECTIONS;
      document.getElementById('min-connections').value = initialMinConnections;
      document.getElementById('connections-value').textContent = initialMinConnections;
      document.getElementById('min-weight').value = DEFAULT_MIN_WEIGHT;
      document.getElementById('weight-value').textContent = DEFAULT_MIN_WEIGHT;
      document.getElementById('weight-description').textContent = weightDescription(DEFAULT_MIN_WEIGHT);
      applyFilters();
      console.log('Auto-filtered to nodes with >=' + initialMinConnections + ' connections');
      console.log('💡 Tip: Use the filters on the left to adjust the minimum connections or search for specific components.');
    }
  </script>
</body>
</html>`;
  }

  private generateHtmlMulti(
    payloads: Array<{
      id: string;
      name: string;
      stats: AnalysisResult['stats'];
      nodes: NodeInput[];
      visNodes: VisNode[];
      visEdges: VisEdge[];
      recommended: { minWeight: number; minConnections: number };
    }>
  ): string {
    const first = payloads[0];
    const datasetsJson = JSON.stringify(
      payloads.map(p => ({
        id: p.id,
        name: p.name,
        stats: p.stats,
        nodes: p.nodes,
        visNodes: p.visNodes,
        visEdges: p.visEdges,
        recommended: p.recommended,
      }))
    );
    const colorMapJson = JSON.stringify(COLOR_MAP);
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Kairo - Multi-dataset dependency graph</title>
  <script src="https://unpkg.com/vis-network@9.1.2/standalone/umd/vis-network.min.js"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; display: flex; flex-direction: column; height: 100vh; }
    #header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px 30px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); display: flex; flex-wrap: wrap; align-items: center; gap: 20px; }
    .header-row-one { display: flex; align-items: center; gap: 24px; flex-wrap: wrap; width: 100%; }
    #header h1 { margin: 0; font-size: 28px; }
    .dataset-switcher { display: flex; align-items: center; gap: 10px; }
    .dataset-switcher label { font-weight: 600; font-size: 14px; }
    .dataset-switcher select { padding: 10px 14px; border-radius: 8px; font-size: 15px; cursor: pointer; min-width: 200px; background: white; color: #333; border: 2px solid rgba(255,255,255,0.5); font-weight: 600; }
    .dataset-switcher select:hover { border-color: white; }
    #stats { display: flex; gap: 30px; font-size: 14px; opacity: 0.9; flex-wrap: wrap; }
    .stat { display: flex; align-items: center; gap: 8px; }
    .stat-value { font-size: 20px; font-weight: bold; }
    #graph { flex: 1; background: #f5f5f5; position: relative; min-height: 0; transform: translateZ(0); }
    #controls { position: absolute; top: 100px; left: 20px; background: white; border-radius: 8px; padding: 15px; box-shadow: 0 4px 20px rgba(0,0,0,0.15); min-width: 250px; }
    .control-section { margin-bottom: 15px; }
    .control-label { font-weight: bold; margin-bottom: 8px; display: block; font-size: 14px; }
    .checkbox-group { display: flex; flex-direction: column; gap: 6px; }
    .checkbox-item { display: flex; align-items: center; gap: 6px; font-size: 13px; }
    input[type="checkbox"] { cursor: pointer; }
    input[type="text"] { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
    button { width: 100%; padding: 8px; background: #667eea; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; margin-top: 8px; }
    button:hover { background: #5568d3; }
    #info-panel { position: absolute; top: 100px; right: 20px; background: white; border-radius: 8px; padding: 15px; box-shadow: 0 4px 20px rgba(0,0,0,0.15); max-width: 300px; display: none; }
    #info-panel.visible { display: block; }
    .info-title { font-weight: bold; font-size: 16px; margin-bottom: 10px; color: #667eea; }
    .info-row { margin: 5px 0; font-size: 14px; }
    .legend { position: absolute; bottom: 20px; right: 20px; background: white; border-radius: 8px; padding: 15px; box-shadow: 0 4px 20px rgba(0,0,0,0.15); }
    .legend-title { font-weight: bold; margin-bottom: 10px; }
    .legend-item { display: flex; align-items: center; gap: 8px; margin: 5px 0; font-size: 14px; }
    .legend-color { width: 16px; height: 16px; border-radius: 50%; }
    div.vis-tooltip {
      position: absolute;
      visibility: hidden;
      padding: 6px 10px;
      white-space: nowrap;
      color: #333;
      background: #fff;
      border-radius: 6px;
      border: 1px solid #ccc;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      pointer-events: none;
      z-index: 1000;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div id="header">
    <div class="header-row-one">
      <h1>Kairo – Salesforce dependency graph</h1>
      <div class="dataset-switcher">
        <label for="dataset-select">Canviar dataset:</label>
        <select id="dataset-select" title="Tria el dataset a visualitzar"></select>
      </div>
    </div>
    <div id="stats">
      <div class="stat"><span>Components:</span><span class="stat-value" id="stat-components">${first.stats.totalComponents}</span></div>
      <div class="stat"><span>Dependencies:</span><span class="stat-value" id="stat-deps">${first.stats.totalDependencies}</span></div>
      <div class="stat"><span>Objects:</span><span class="stat-value" id="stat-objects">${first.stats.componentsByType.CustomObject || 0}</span></div>
      <div class="stat"><span>Apex:</span><span class="stat-value" id="stat-apex">${(first.stats.componentsByType.ApexClass || 0) + (first.stats.componentsByType.ApexTrigger || 0)}</span></div>
    </div>
  </div>
  <div id="graph"></div>
  <div id="controls">
    <div class="control-section">
      <label class="control-label">Dataset</label>
      <select id="dataset-select-controls" title="Tria el dataset a visualitzar"></select>
    </div>
    <div class="control-section">
      <label class="control-label">Search</label>
      <input type="text" id="search-input" placeholder="Type to filter nodes...">
      <button onclick="resetView()">Reset View</button>
      <button onclick="applyRecommended()">Auto Focus</button>
    </div>

    <div class="control-section">
      <label class="control-label">Filter by Type</label>
      <div class="checkbox-group">
        <label class="checkbox-item">
          <input type="checkbox" value="CustomObject" checked onchange="filterByType()"> Objects
        </label>
        <label class="checkbox-item">
          <input type="checkbox" value="ApexClass" checked onchange="filterByType()"> Apex Classes
        </label>
        <label class="checkbox-item">
          <input type="checkbox" value="ApexTrigger" checked onchange="filterByType()"> Triggers
        </label>
        <label class="checkbox-item">
          <input type="checkbox" value="Flow" checked onchange="filterByType()"> Flows
        </label>
        <label class="checkbox-item">
          <input type="checkbox" value="LightningWebComponent" checked onchange="filterByType()"> LWC
        </label>
        <label class="checkbox-item">
          <input type="checkbox" value="AuraComponent" checked onchange="filterByType()"> Aura
        </label>
      </div>
    </div>

    <div class="control-section">
      <label class="control-label">Min Connections</label>
      <input type="range" id="min-connections" min="0" max="20" value="${first.recommended.minConnections}" onchange="filterByConnections(this.value)">
      <span id="connections-value">${first.recommended.minConnections}</span>
    </div>

    <div class="control-section">
      <label class="control-label">Dependency Weight Filter</label>
      <input type="range" id="min-weight" min="0" max="10" value="${first.recommended.minWeight}" onchange="filterByWeight(this.value)">
      <div style="display: flex; justify-content: space-between; font-size: 11px; margin-top: 4px;">
        <span>All</span>
        <span id="weight-value">${first.recommended.minWeight}</span>
        <span>Process Only</span>
      </div>
      <div style="font-size: 11px; color: #666; margin-top: 4px;" id="weight-description">${describeWeight(first.recommended.minWeight)}</div>
    </div>

    <div class="control-section">
      <label class="control-label">Weak Relation Threshold</label>
      <input type="range" id="weak-threshold" min="1" max="10" value="5" step="0.5" onchange="updatePhysics()">
      <div style="display: flex; justify-content: space-between; font-size: 11px; margin-top: 4px;">
        <span>1</span>
        <span id="weak-threshold-value">5</span>
        <span>10</span>
      </div>
      <div style="font-size: 11px; color: #666; margin-top: 4px;">Relations below this weight are considered weak</div>
    </div>

    <div class="control-section">
      <label class="control-label">Weak Relation Repulsion</label>
      <input type="range" id="weak-repulsion" min="1" max="50" value="5" step="0.5" onchange="updatePhysics()">
      <div style="display: flex; justify-content: space-between; font-size: 11px; margin-top: 4px;">
        <span>Less</span>
        <span id="weak-repulsion-value">5</span>
        <span>50</span>
      </div>
      <div style="font-size: 11px; color: #666; margin-top: 4px;">How much weak relations repel each other</div>
    </div>
  </div>

  <div id="info-panel">
    <div class="info-title" id="info-name"></div>
    <div class="info-row"><span class="info-label">Type:</span> <span id="info-type"></span></div>
    <div class="info-row"><span class="info-label">ID:</span> <span id="info-id"></span></div>
    <div class="info-row"><span class="info-label">Dependencies:</span> <span id="info-deps"></span></div>
  </div>

  <div class="legend">
    <div class="legend-title">Component Types</div>
    <div class="legend-item">
      <div class="legend-color" style="background: #4CAF50;"></div>
      <span>Custom Object</span>
    </div>
    <div class="legend-item">
      <div class="legend-color" style="background: #2196F3;"></div>
      <span>Apex Class</span>
    </div>
    <div class="legend-item">
      <div class="legend-color" style="background: #FF9800;"></div>
      <span>Apex Trigger</span>
    </div>
    <div class="legend-item">
      <div class="legend-color" style="background: #9C27B0;"></div>
      <span>Flow</span>
    </div>
    <div class="legend-item">
      <div class="legend-color" style="background: #E91E63;"></div>
      <span>LWC / Aura</span>
    </div>
    <hr style="margin: 12px 0; border: none; border-top: 1px solid #eee;">
    <div class="legend-title">Dependency Weights</div>
    <div class="legend-item">
      <div style="width: 30px; height: 3px; background: #E91E63;"></div>
      <span style="font-size: 12px;">Critical (9-10)</span>
    </div>
    <div class="legend-item">
      <div style="width: 30px; height: 2.5px; background: #9C27B0;"></div>
      <span style="font-size: 12px;">Business (7-8)</span>
    </div>
    <div class="legend-item">
      <div style="width: 30px; height: 2px; background: #2196F3;"></div>
      <span style="font-size: 12px;">Structure (5-6)</span>
    </div>
    <div class="legend-item">
      <div style="width: 30px; height: 1px; background: #757575;"></div>
      <span style="font-size: 12px;">Operations (3-4)</span>
    </div>
    <div class="legend-item">
      <div style="width: 30px; height: 0.5px; background: #ccc;"></div>
      <span style="font-size: 12px;">Infrastructure (1-2)</span>
    </div>
  </div>

  <script>
    const allDatasets = ${datasetsJson};
    const colorMap = ${colorMapJson};

    function populateDatasetSelects() {
      const selectHeader = document.getElementById('dataset-select');
      const selectControls = document.getElementById('dataset-select-controls');
      [selectHeader, selectControls].forEach(sel => {
        sel.innerHTML = '';
        allDatasets.forEach((d, i) => {
          const opt = document.createElement('option');
          opt.value = i;
          opt.textContent = d.name;
          sel.appendChild(opt);
        });
      });
    }
    populateDatasetSelects();

    const selectEl = document.getElementById('dataset-select');
    const selectControls = document.getElementById('dataset-select-controls');
    function onDatasetChange(index) {
      selectEl.value = index;
      selectControls.value = index;
      switchDataset(index);
    }

    const container = document.getElementById('graph');
    const nodesDataset = new vis.DataSet(allDatasets[0].visNodes);
    const edgesDataset = new vis.DataSet(allDatasets[0].visEdges);
    const data = { nodes: nodesDataset, edges: edgesDataset };
    const options = {
      physics: { enabled: true, barnesHut: { gravitationalConstant: -5000, centralGravity: 0.03, springLength: 150, springConstant: 0.005, avoidOverlap: 0.5, damping: 0.5 }, stabilization: { enabled: true, iterations: 250 }, solver: 'barnesHut' },
      nodes: { shape: 'dot', font: { size: 12, color: '#333' }, borderWidth: 2 },
      edges: { width: 1, smooth: { enabled: false }, arrows: { to: { enabled: true, scaleFactor: 0.5 } } },
    };
    const network = new vis.Network(container, data, options);

    // Show labels only at high zoom levels to avoid clutter
    const LABEL_ZOOM_THRESHOLD = 2.0;
    let labelsVisible = false;
    function updateLabelsForZoom(scale) {
      const shouldShow = scale >= LABEL_ZOOM_THRESHOLD;
      if (shouldShow === labelsVisible) return;
      labelsVisible = shouldShow;
      const updates = nodesDataset.get().map(n => ({
        id: n.id,
        label: shouldShow ? n.fullLabel : '',
      }));
      nodesDataset.update(updates);
    }
    network.on('zoom', function(params) { updateLabelsForZoom(params.scale); });
    updateLabelsForZoom(network.getScale());

    let currentIndex = 0;
    let currentNodes = allDatasets[0].nodes;
    let allNodes = allDatasets[0].visNodes.slice();
    let allEdges = allDatasets[0].visEdges.slice();
    let currentRecommended = allDatasets[0].recommended;
    let connectionCounts = new Map();
    let shouldFreeze = allDatasets[0].visNodes.length <= 900;

    function weightDescription(value) {
      const descriptions = {
        0: 'Showing all dependencies',
        1: 'Hiding infrastructure references',
        3: 'Data operations and above',
        5: 'Code structure and above',
        7: 'Business logic only',
        9: 'Critical processes only'
      };
      return descriptions[value] || \`Weight >= \${value}\`;
    }

    function recomputeConnectionCounts() {
      connectionCounts = new Map();
      allEdges.forEach(edge => {
        connectionCounts.set(edge.from, (connectionCounts.get(edge.from) || 0) + 1);
        connectionCounts.set(edge.to, (connectionCounts.get(edge.to) || 0) + 1);
      });
    }
    recomputeConnectionCounts();

    const FIDELITY_PULL = 0.5;
    function edgeFidelity(fromId, toId) {
      const degFrom = Math.max(1, connectionCounts.get(fromId) || 0);
      const degTo = Math.max(1, connectionCounts.get(toId) || 0);
      return Math.min(1, 1 / Math.sqrt(degFrom * degTo));
    }

    function updateStats(index) {
      const s = allDatasets[index].stats;
      document.getElementById('stat-components').textContent = s.totalComponents;
      document.getElementById('stat-deps').textContent = s.totalDependencies;
      document.getElementById('stat-objects').textContent = s.componentsByType.CustomObject || 0;
      document.getElementById('stat-apex').textContent = (s.componentsByType.ApexClass || 0) + (s.componentsByType.ApexTrigger || 0);
    }

    function switchDataset(index) {
      currentIndex = index;
      const d = allDatasets[index];
      currentNodes = d.nodes;
      allNodes = d.visNodes.slice();
      allEdges = d.visEdges.slice();
      currentRecommended = d.recommended;
      shouldFreeze = d.visNodes.length <= 900;
      recomputeConnectionCounts();
      updateStats(index);
      applyPhysicsMode();
      resetView();
    }

    selectEl.addEventListener('change', function() { onDatasetChange(parseInt(this.value, 10)); });
    selectControls.addEventListener('change', function() { onDatasetChange(parseInt(this.value, 10)); });

    function applyPhysicsMode() {
      if (shouldFreeze) {
        network.once('stabilized', function() {
          setTimeout(function() { network.setOptions({ physics: false }); }, 500);
        });
      } else {
        network.setOptions({ physics: { enabled: true, stabilization: { enabled: false } } });
      }
    }
    applyPhysicsMode();

    network.on('click', function(params) {
      const infoPanel = document.getElementById('info-panel');
      if (params.nodes.length > 0) {
        const nodeId = params.nodes[0];
        const node = currentNodes.find(n => n.id === nodeId);
        if (node) {
          const connectedEdges = network.getConnectedEdges(nodeId);
          document.getElementById('info-name').textContent = node.label || node.name;
          document.getElementById('info-type').textContent = node.type;
          document.getElementById('info-id').textContent = node.id;
          document.getElementById('info-deps').textContent = connectedEdges.length;
          infoPanel.classList.add('visible');
        }
      } else {
        infoPanel.classList.remove('visible');
      }
    });

    function applyFilters() {
      const checkboxes = document.querySelectorAll('#controls input[type=\"checkbox\"]');
      const selectedTypes = Array.from(checkboxes)
        .filter(cb => cb.checked)
        .map(cb => cb.value);

      const minConn = parseInt(document.getElementById('min-connections').value, 10) || 0;
      const minWeight = parseInt(document.getElementById('min-weight').value, 10) || 0;

      const typeFilteredNodes = allNodes.filter(node => selectedTypes.includes(node.metadata.type));
      const typeNodeIds = new Set(typeFilteredNodes.map(n => n.id));

      let filteredEdges = allEdges.filter(edge => (edge.weight || 3) >= minWeight);
      filteredEdges = filteredEdges.filter(edge => typeNodeIds.has(edge.from) && typeNodeIds.has(edge.to));

      const connectionCounts = new Map();
      filteredEdges.forEach(edge => {
        connectionCounts.set(edge.from, (connectionCounts.get(edge.from) || 0) + 1);
        connectionCounts.set(edge.to, (connectionCounts.get(edge.to) || 0) + 1);
      });

      const filteredNodes = typeFilteredNodes.filter(node => (connectionCounts.get(node.id) || 0) >= minConn);
      const finalNodeIds = new Set(filteredNodes.map(n => n.id));
      filteredEdges = filteredEdges.filter(edge => finalNodeIds.has(edge.from) && finalNodeIds.has(edge.to));

      const positions = network.getPositions();
      const nodesWithPositions = filteredNodes.map(node => ({
        ...node,
        x: positions[node.id]?.x,
        y: positions[node.id]?.y,
        fixed: { x: false, y: false },
      }));

      nodesDataset.clear();
      edgesDataset.clear();
      nodesDataset.add(nodesWithPositions);
      edgesDataset.add(filteredEdges);
      updateLabelsForZoom(network.getScale());
    }

    function filterByType() {
      applyFilters();
    }

    function filterByConnections(val) {
      document.getElementById('connections-value').textContent = val;
      applyFilters();
    }

    function filterByWeight(minWeight) {
      document.getElementById('weight-value').textContent = minWeight;

      document.getElementById('weight-description').textContent = weightDescription(minWeight);
      applyFilters();
    }

    function applyRecommended() {
      const minConnEl = document.getElementById('min-connections');
      const minWeightEl = document.getElementById('min-weight');
      if (minConnEl) minConnEl.value = currentRecommended.minConnections;
      if (minWeightEl) minWeightEl.value = currentRecommended.minWeight;
      document.getElementById('connections-value').textContent = currentRecommended.minConnections;
      filterByWeight(currentRecommended.minWeight);
    }

    function updatePhysics() {
      const weakThreshold = parseFloat(document.getElementById('weak-threshold').value);
      const weakRepulsion = parseFloat(document.getElementById('weak-repulsion').value);

      document.getElementById('weak-threshold-value').textContent = weakThreshold.toFixed(1);
      document.getElementById('weak-repulsion-value').textContent = weakRepulsion.toFixed(1);

      const updatedEdges = allEdges.map(edge => {
        const weight = edge.weight || 3;
        const fidelity = edge.fidelity != null ? edge.fidelity : edgeFidelity(edge.from, edge.to);
        let springLength;

        if (weight >= weakThreshold) {
          const factor = 10 - weight;
          springLength = Math.max(25, 25 + (factor * 15));
        } else {
          const baseSeparation = 200;
          const repulsionMultiplier = weakRepulsion / 5;
          const weightFactor = (weakThreshold - weight) / weakThreshold;
          springLength = baseSeparation + (weightFactor * 400 * repulsionMultiplier);
        }
        springLength = springLength * (1 - fidelity * FIDELITY_PULL);

        return { ...edge, length: springLength };
      });

      edgesDataset.clear();
      edgesDataset.add(updatedEdges);

      network.setOptions({ physics: { enabled: true } });
      if (shouldFreeze) {
        setTimeout(() => {
          network.setOptions({ physics: { enabled: false } });
        }, 5000);
      }
    }

    function resetView() {
      const d = allDatasets[currentIndex];
      const searchInput = document.getElementById('search-input');
      if (searchInput) searchInput.value = '';

      const checkboxes = document.querySelectorAll('#controls input[type=\"checkbox\"]');
      checkboxes.forEach(cb => { cb.checked = true; });

      const minWeightEl = document.getElementById('min-weight');
      if (minWeightEl) minWeightEl.value = currentRecommended.minWeight;
      document.getElementById('weight-value').textContent = currentRecommended.minWeight;
      document.getElementById('weight-description').textContent = weightDescription(currentRecommended.minWeight);

      const weakThresholdEl = document.getElementById('weak-threshold');
      const weakRepulsionEl = document.getElementById('weak-repulsion');
      if (weakThresholdEl) weakThresholdEl.value = 5;
      if (weakRepulsionEl) weakRepulsionEl.value = 5;
      document.getElementById('weak-threshold-value').textContent = '5';
      document.getElementById('weak-repulsion-value').textContent = '5';

      document.getElementById('min-connections').value = currentRecommended.minConnections;
      document.getElementById('connections-value').textContent = currentRecommended.minConnections;
      applyFilters();
      network.fit();
      updatePhysics();
    }

    // Apply default filters on initial load
    resetView();

    document.getElementById('search-input').addEventListener('input', function(e) {
      const term = e.target.value.toLowerCase();
      if (term.length < 2) { resetView(); return; }
      const filtered = allNodes.filter(n => (n.metadata.name && n.metadata.name.toLowerCase().includes(term)) || (n.title && n.title.toLowerCase().includes(term)));
      const ids = new Set(filtered.map(n => n.id));
      allEdges.forEach(edge => {
        if (ids.has(edge.from)) ids.add(edge.to);
        if (ids.has(edge.to)) ids.add(edge.from);
      });
      const extended = allNodes.filter(n => ids.has(n.id));
      const edgeSubset = allEdges.filter(e => ids.has(e.from) && ids.has(e.to));
      nodesDataset.clear();
      edgesDataset.clear();
      nodesDataset.add(extended);
      edgesDataset.add(edgeSubset);
      updateLabelsForZoom(network.getScale());
      if (filtered.length > 0) network.fit({ nodes: Array.from(ids) });
    });
  </script>
</body>
</html>`;
  }
}
