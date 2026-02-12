import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import type { AnalysisResult, Dependency } from '../types.js';
import { DependencyWeightCalculator } from '../utils/DependencyWeightCalculator.js';
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';

type NodeInput = { id: string; label: string; type: string; name: string };
type EdgeInput = { from: string; to: string; label: string; weight: number };
type VisNode = {
  id: string;
  label: string;
  fullLabel: string;
  title: string;
  color?: string | Record<string, unknown>;
  font: { size: number; color: string };
  shape: string;
  size: number;
  image?: string;
  borderWidth?: number;
  borderWidthSelected?: number;
  shapeProperties?: Record<string, unknown>;
  heatColor?: string;
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
  baseLength: number;
  title?: string;
  dashes?: boolean | number[];
  weight: number;
  fidelity: number;
};

const COLOR_MAP: Record<string, string> = {
  CustomObject: '#DA70D6',
  ApexClass: '#00BCD4',
  ApexTrigger: '#1565C0',
  Flow: '#9C27B0',
  LightningWebComponent: '#FF9800',
  AuraComponent: '#E65100',
};

const FIDELITY_PULL = 0.5;
const STANDARD_OBJECT_ICONS: Record<string, string> = {
  account: 'account',
  contact: 'contact',
  case: 'case',
  opportunity: 'opportunity',
  lead: 'lead',
  campaign: 'campaign',
  task: 'task',
  event: 'event',
  contract: 'contract',
  asset: 'product',
  product: 'product',
  order: 'product',
  report: 'report',
  dashboard: 'dashboard',
};
    const ICON_BASE = 'https://v1.lightningdesignsystem.com/assets/icons/standard/';

function stripObjectSuffix(name: string): string {
  if (!name) return '';
  const cleaned = name.replace(/__c$/i, '').replace(/__r$/i, '');
  return cleaned.toLowerCase();
}

function getStandardIconForNode(node: NodeInput): string | null {
  if (!node || node.type !== 'CustomObject') return null;
  const name = stripObjectSuffix(node.label || node.name || node.id || '');
  return STANDARD_OBJECT_ICONS[name] || null;
}

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
  minWeight = clamp(Math.max(3, Math.round(minWeight)), 0, 10);

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

  // Down-weight low-signal edges (observed majority in project)
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

  // Penalize hub targets for low/medium signal edges (based on project degree distribution)
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
  const graph = new Graph({ type: 'undirected', allowSelfLoops: true, multi: true });
  nodes.forEach(node => {
    if (!graph.hasNode(node.id)) graph.addNode(node.id);
  });
  edges.forEach((edge, index) => {
    const edgeKey = `edge-${index}`;
    try {
      if (!graph.hasEdge(edgeKey)) {
        graph.addEdgeWithKey(edgeKey, edge.from, edge.to, { weight: edge.weight || 1 });
      }
    } catch {
      // ignore duplicate edge keys
    }
  });
  let communityPartition: Record<string, string | number> = {};
  try {
    communityPartition = louvain(graph) as unknown as Record<string, string | number>;
  } catch {
    communityPartition = {};
  }
  const palette = ['#3d5afe', '#ff6ec7', '#1de9b6', '#ffc107', '#ff7043', '#42a5f5', '#9c27b0', '#00bfa5', '#f06292', '#7cb342'];
  const communityColorLookup = new Map<string, string>();
  const nodeCommunityColor = new Map<string, string>();
  Object.entries(communityPartition).forEach(([nodeId, community]) => {
    const key = String(community);
    if (!communityColorLookup.has(key)) {
      const color = palette[communityColorLookup.size % palette.length];
      communityColorLookup.set(key, color);
    }
    const color = communityColorLookup.get(key);
    if (color) {
      nodeCommunityColor.set(nodeId, color);
    }
  });
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
    const iconName = getStandardIconForNode(node);
    const iconUrl = iconName ? `${ICON_BASE}${iconName}.svg` : undefined;
    const hasIcon = Boolean(iconUrl);
    const baseHex = COLOR_MAP[node.type] || '#999';
    const nodeColor = {
      background: baseHex,
      border: baseHex,
      highlight: { background: baseHex, border: baseHex },
      hover: { background: baseHex, border: baseHex },
    };
    return {
      id: node.id,
      label: '',
      fullLabel: node.name,
      title: String(node.label || node.name || node.id || node.type || ''),
      color: hasIcon
        ? {
            background: 'transparent',
            border: baseHex,
            highlight: { background: 'transparent', border: baseHex },
            hover: { background: 'transparent', border: baseHex },
          }
        : nodeColor,
      font: { size: 12, color: '#ffffff' },
      shape: hasIcon ? 'image' : 'dot',
      size: hasIcon ? 42 : nodeSize,
      image: iconUrl,
      borderWidth: hasIcon ? 2 : undefined,
      borderWidthSelected: hasIcon ? 3 : undefined,
      shapeProperties: hasIcon
        ? { useBorderWithImage: true, useImageSize: false, borderDashes: false }
        : { borderDashes: false },
      heatColor: nodeCommunityColor.get(node.id) || baseHex,
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
    const color = '#9C27B0';
      return {
        id: i,
        from: edge.from,
        to: edge.to,
        arrows: 'to',
        color: { color, opacity },
        width,
        length: springLength,
        baseLength: springLength,
        weight,
        fidelity,
      };
  });
  return { visNodes, visEdges };
}

export class HtmlVisualizer {
  /** Build nodes and edges from AnalysisResult. */
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

      // Non-linear boost for multiple references (rare in this project but improves signal)
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

  /** Generate full graph view HTML for a single Salesforce project (for server use). */
  generateHtmlForProject(result: AnalysisResult, id: string, name: string): string {
    const payload = this.buildGraphPayload(result, id, name);
    return this.generateHtml([payload]);
  }

  /** Build graph payload for a single Salesforce project (for API use). */
  buildGraphPayload(
    result: AnalysisResult,
    id: string,
    name: string
  ): {
    id: string;
    name: string;
    stats: AnalysisResult['stats'];
    nodes: NodeInput[];
    visNodes: VisNode[];
    visEdges: VisEdge[];
    recommended: { minWeight: number; minConnections: number };
  } {
    const { nodes, edges } = this.buildNodesAndEdges(result);
    const { visNodes, visEdges } = buildVisData(nodes, edges);
    const recommended = computeRecommendedFilters(edges);
    return { id, name, stats: result.stats, nodes, visNodes, visEdges, recommended };
  }

  generate(
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
    const html = this.generateHtml(payloads);
    writeFileSync(outputPath, html);
    console.log(`📊 Visualization saved to: ${outputPath}`);
  }

  private generateHtml(
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
    const defaultStats = { totalComponents: 0, totalDependencies: 0, componentsByType: {} as Record<string, number> };
    const defaultRecommended = { minWeight: 3, minConnections: 1 };
    const first = payloads[0];
    const stats = first?.stats ?? defaultStats;
    const recommended = first?.recommended ?? defaultRecommended;
    const projectsJson = JSON.stringify(
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
  <title>Kairo - Dependency graph</title>
  <script src="https://unpkg.com/vis-network@9.1.2/standalone/umd/vis-network.min.js"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; display: flex; flex-direction: column; height: 100vh; }
    #header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); display: flex; align-items: center; justify-content: space-between; gap: 20px; }
    #header .back-link { color: white; text-decoration: none; opacity: 0.95; margin-right: 20px; font-size: 15px; font-weight: 600; padding: 6px 12px; background: rgba(255,255,255,0.15); border-radius: 8px; white-space: nowrap; flex-shrink: 0; }
    #header .back-link:hover { opacity: 1; background: rgba(255,255,255,0.25); }
    .header-row-one { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; }
    #header h1 { margin: 0; font-size: 24px; display: none; }
    .project-switcher { display: flex; align-items: center; gap: 0; }
    .project-switcher label { display: none; }
    .project-switcher select { padding: 0; border-radius: 0; font-size: 18px; cursor: pointer; background: transparent; color: white; border: none; font-weight: 600; min-width: auto; appearance: none; -webkit-appearance: none; -moz-appearance: none; background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e"); background-repeat: no-repeat; background-position: right 2px center; background-size: 18px; padding-right: 24px; }
    .project-switcher select:hover { opacity: 0.9; }
    #stats { display: flex; gap: 20px; font-size: 13px; opacity: 0.9; flex-wrap: wrap; align-items: center; }
    .stat { display: flex; align-items: center; gap: 6px; }
    .stat-value { font-size: 20px; font-weight: bold; }
    #graph-wrapper { position: relative; flex: 1; min-height: 0; display: flex; }
    #graph { flex: 1; background: #000; position: relative; min-height: 0; transform: translateZ(0); }
    #heatmap {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      opacity: 0.85;
      mix-blend-mode: screen;
      z-index: 2;
    }
    .empty-state { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.95); font-size: 18px; color: #999; text-align: center; padding: 40px; }
    .stabilization-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.85); font-size: 18px; color: #ccc; text-align: center; z-index: 100; transition: opacity 0.3s ease; }
    .stabilization-overlay.hidden { opacity: 0; pointer-events: none; }
    #controls { position: absolute; top: 100px; left: 20px; background: rgba(255, 255, 255, 0.15); border-radius: 8px; padding: 0px; box-shadow: 0 4px 20px rgba(0,0,0,0.15); width: 280px; max-height: calc(100vh - 130px); overflow-y: auto; touch-action: none; user-select: none; z-index: 1000; backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }
    #controls-header { background: linear-gradient(135deg, #667eea 0%, #5568d3 100%); color: white; padding: 10px; border-radius: 8px 8px 0 0; cursor: move; font-weight: 600; font-size: 13px; display: flex; justify-content: space-between; align-items: center; touch-action: none; }
    #controls-content { padding: 10px; overflow-y: auto; max-height: calc(100vh - 160px); }
    .control-section { margin-bottom: 7px; }
    .control-section:has(> .compact-slider-row) { background: transparent; }
    .control-label { font-weight: 600; margin-bottom: 4px; display: block; font-size: 12px; color: #fff; }
    .control-inline { display: flex; gap: 6px; align-items: center; margin-top: 8px; justify-content: flex-end; }
    .control-inline button { margin-top: 0; flex: 0 1 auto; }
    .compact-options-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 8px; }
    .compact-slider-row {
      margin-bottom: 14px;
      border-radius: 10px;
      padding: 12px;
    }
    .compact-slider-row:last-child { margin-bottom: 0; }
    .slider-track-area {
      position: relative;
      margin-top: 8px;
      overflow: visible;
    }
    .slider-track-area input[type="range"] {
      display: block;
      width: 100%;
      height: 20px;
    }
    .sliderValue {
      position: relative;
      width: 100%;
      height: 0;
      overflow: visible;
    }
    .sliderValue span {
      display: block;
      position: absolute;
      height: 34px;
      width: 34px;
      font-weight: 500;
      top: -30px;
      line-height: 42px;
      text-align: center;
      z-index: 100;
      color: #fff;
      font-size: 10px;
      pointer-events: none;
      transform: translateX(-70%) scale(0);
      transform-origin: bottom;
      opacity: 0;
      transition: opacity 0.2s ease-in-out, transform 0.2s ease-in-out;
      will-change: transform, opacity;
    }
    .sliderValue span.show {
      opacity: 1;
      transform: translateX(-70%) scale(1);
    }
    .compact-slider-row { overflow: visible; }
    .sliderValue span::after {
      position: absolute;
      content: '';
      height: 100%;
      width: 100%;
      background: #664AFF;
      border: 2px solid #fff;
      z-index: -1;
      left: 50%;
      transform: translateX(-50%) rotate(45deg);
      border-bottom-left-radius: 50%;
      border-top-left-radius: 50%;
      border-top-right-radius: 50%;
      box-shadow: 0px 0px 8px rgba(0, 0, 0, 0.1);
    }
    .slider-scale { display: flex; justify-content: space-between; font-size: 10px; color: #999; margin-top: 2px; }
    .slider-help { font-size: 10px; color: #999; margin-top: 4px; line-height: 1.2; }
    .advanced-group { border: 1px solid rgba(255, 255, 255, 0.3); border-radius: 6px; padding: 4px 6px 6px; margin-bottom: 7px; background: rgba(0, 0, 0, 0.2); }
    .advanced-group summary { cursor: pointer; font-size: 11px; font-weight: 700; color: #ffffff; list-style: none; display: flex; align-items: center; gap: 6px; user-select: none; }
    .advanced-group summary::-webkit-details-marker { display: none; }
    .advanced-group summary::before { content: '▸'; font-size: 10px; transition: transform 0.15s ease; }
    .advanced-group[open] summary::before { transform: rotate(90deg); }
    .checkbox-group { display: flex; flex-direction: row; flex-wrap: wrap; gap: 6px; align-items: center; }
    .checkbox-item { display: inline-flex; align-items: center; gap: 0; font-size: 12px; color: #ffffff; background: rgba(102, 126, 234, 0.4); border: none; border-radius: 4px; padding: 4px 8px; cursor: pointer; user-select: none; transition: all 0.2s ease; }
    .checkbox-item:hover { background: rgba(102, 126, 234, 0.6); }
    input[type="checkbox"]:checked + .checkbox-label, .checkbox-item input[type="checkbox"]:checked { display: none; }
    .checkbox-item input[type="checkbox"] { display: none; }
    .checkbox-item input[type="checkbox"]:checked ~ * { display: none; }
    .checkbox-item input[type="checkbox"]:checked { display: none; }
    .checkbox-item:has(input[type="checkbox"]:checked) { background: #667eea; border-color: #80d5ff; box-shadow: 0 0 8px rgba(102, 126, 234, 0.6); }
    input[type="checkbox"] { cursor: pointer; }
    input[type="text"] { width: 100%; padding: 4px; border: 1px solid rgba(255, 255, 255, 0.3); border-radius: 4px; font-size: 12px; background: rgba(0, 0, 0, 0.3); color: #ffffff; box-sizing: border-box; }
    input[type="text"]::placeholder { color: rgba(255, 255, 255, 0.6); }
    input[type="range"] {
      -webkit-appearance: none;
      appearance: none;
      width: 100%;
      height: 16px;
      background: transparent;
      border-radius: 999px;
      outline: none;
      border: none;
      cursor: pointer;
    }
    input[type="range"]::-webkit-slider-runnable-track {
      height: 2px;
      background: linear-gradient(90deg, #c9d0f0 0%, #d7dbee 100%);
      border-radius: 999px;
    }
    input[type="range"]::-moz-range-track {
      height: 2px;
      background: linear-gradient(90deg, #c9d0f0 0%, #d7dbee 100%);
      border-radius: 999px;
    }
    input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #664AFF;
      border: 1px solid #664AFF;
      cursor: pointer;
      margin-top: -5px;
    }
    input[type="range"]::-moz-range-thumb {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #664AFF;
      border: 1px solid #664AFF;
      cursor: pointer;
    }
    input[type="range"]::-moz-range-progress {
      background: #664AFF;
    }
    select { background: rgba(0, 0, 0, 0.3); color: #ffffff; border: 1px solid rgba(255, 255, 255, 0.3); border-radius: 4px; padding: 6px; font-size: 12px; }
    select option { background: #333; color: #ffffff; }
    button { width: 100%; padding: 6px 8px; background: #667eea; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; margin-top: 6px; }
    button:hover { background: #5568d3; }
    #info-panel { position: absolute; top: 100px; right: 20px; background: transparent; border-radius: 8px; padding: 15px; box-shadow: 0 4px 20px rgba(0,0,0,0.15); max-width: 300px; display: none; backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }
    #info-panel.visible { display: block; }
    .info-title-wrapper { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .info-icon { width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; background: rgba(102, 126, 234, 0.15); border: 2px solid #667eea; border-radius: 8px; }
    .info-icon svg,
    .info-icon img { width: 32px; height: 32px; fill: #0b0f50; }
    .info-title { font-weight: bold; font-size: 16px; margin-bottom: 10px; color: #667eea; }
    .info-row { margin: 5px 0; font-size: 14px; }
    .legend { position: fixed; bottom: 20px; right: 20px; background: rgba(255, 255, 255, 0.15); border-radius: 8px; padding: 0px; box-shadow: 0 4px 20px rgba(0,0,0,0.15); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); z-index: 9999; touch-action: none; user-select: none; width: 220px; pointer-events: auto; }
    .legend-header { background: linear-gradient(135deg, #667eea 0%, #5568d3 100%); color: white; padding: 10px; border-radius: 8px 8px 0 0; cursor: move; font-weight: 600; font-size: 13px; display: flex; justify-content: space-between; align-items: center; touch-action: none; }
    .legend-content { padding: 15px; }
    .legend-title { font-weight: bold; margin-bottom: 10px; color: #ffffff; }
    .legend-item { display: flex; align-items: center; gap: 8px; margin: 5px 0; font-size: 12px; color: #ffffff; }
    .legend-color { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
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
      <a href="./" class="back-link" title="Tornar a la homepage">← Tornar</a>
      <div class="project-switcher">
        <select id="project-select" title="Tria el projecte Salesforce a visualitzar"></select>
      </div>
    </div>
    <div id="stats">
      <div class="stat"><span>Components:</span><span class="stat-value" id="stat-components">${stats.totalComponents}</span></div>
      <div class="stat"><span>Dependencies:</span><span class="stat-value" id="stat-deps">${stats.totalDependencies}</span></div>
      <div class="stat"><span>Objects:</span><span class="stat-value" id="stat-objects">${stats.componentsByType?.CustomObject || 0}</span></div>
      <div class="stat"><span>Apex:</span><span class="stat-value" id="stat-apex">${(stats.componentsByType?.ApexClass || 0) + (stats.componentsByType?.ApexTrigger || 0)}</span></div>
    </div>
  </div>
  <div id="graph-wrapper">
    <div id="graph"></div>
    <div id="empty-state" class="empty-state" style="display: none;">Selecciona un projecte Salesforce per continuar</div>
    <div id="stabilization-overlay" class="stabilization-overlay">Organitzant el graf…</div>
  </div>
  <div id="controls">
    <div id="controls-header">Parameters<span id="controls-toggle" style="cursor: pointer; font-size: 16px;">−</span></div>
    <div id="controls-content">
    <div class="control-section">
      <label class="control-label">Search</label>
      <input type="text" id="search-input" placeholder="Type to filter nodes...">
      <div class="control-inline">
        <button onclick="resetView()">Reset View</button>
        <button onclick="applyRecommended()">Auto Focus</button>
      </div>
    </div>

    <div class="control-section">
      <label class="control-label">Show</label>
      <div class="checkbox-group compact-options-grid">
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
      <div class="compact-slider-row">
        <label class="control-label" for="min-connections">Min Connections</label>
        <div class="slider-track-area">
          <div class="sliderValue"><span>${recommended.minConnections}</span></div>
          <input type="range" id="min-connections" min="0" max="20" value="${recommended.minConnections}" oninput="filterByConnections(this.value)">
        </div>
      </div>
      <div class="compact-slider-row">
        <label class="control-label" for="min-members">Min Island Size</label>
        <div class="slider-track-area">
          <div class="sliderValue"><span>3</span></div>
          <input type="range" id="min-members" min="1" max="50" value="3" oninput="filterByMembers(this.value)">
        </div>
      </div>
      <div class="compact-slider-row">
        <label class="control-label" for="min-weight">Dependency Weight</label>
        <div class="slider-track-area">
          <div class="sliderValue"><span>3</span></div>
          <input type="range" id="min-weight" min="0" max="10" value="3" oninput="filterByWeight(this.value)">
        </div>
        <div class="slider-scale">
          <span>All</span>
          <span>Process</span>
        </div>
        <div class="slider-help" id="weight-description">${describeWeight(3)}</div>
      </div>
      <div class="compact-slider-row">
        <label class="control-label" for="weak-threshold">Threshold</label>
        <div class="slider-track-area">
          <div class="sliderValue"><span>3.5</span></div>
          <input type="range" id="weak-threshold" min="1" max="10" value="3.5" step="0.5" onchange="updatePhysics()">
        </div>
      </div>
      <div class="compact-slider-row">
        <label class="control-label" for="weak-repulsion">Repulsion</label>
        <div class="slider-track-area">
          <div class="sliderValue"><span>40</span></div>
          <input type="range" id="weak-repulsion" min="1" max="50" value="40" step="0.5" onchange="updatePhysics()">
        </div>
      </div>
    </div>
  </div>
  </div>

  <div id="info-panel">
    <div class="info-title-wrapper">
      <div class="info-icon" id="info-icon"></div>
      <div class="info-title" id="info-name"></div>
    </div>
    <div class="info-row"><span class="info-label">Type:</span> <span id="info-type"></span></div>
    <div class="info-row"><span class="info-label">ID:</span> <span id="info-id"></span></div>
    <div class="info-row"><span class="info-label">Dependencies:</span> <span id="info-deps"></span></div>
  </div>

  <div class="legend">
    <div class="legend-header">Legend<span id="legend-toggle" style="cursor: pointer; font-size: 16px;">−</span></div>
    <div class="legend-content">
      <div class="legend-title">Zoom</div>
      <div class="legend-item">Scale: <span id="legend-zoom-value">1.00</span></div>
      <div class="legend-title">Component Types</div>
      <div class="legend-item">
        <div class="legend-color" style="background: #DA70D6;"></div>
        <span>Objects</span>
      </div>
      <div class="legend-item">
        <div class="legend-color" style="background: #00BCD4;"></div>
        <span>Apex Classes</span>
      </div>
      <div class="legend-item">
        <div class="legend-color" style="background: #1565C0;"></div>
        <span>Triggers</span>
      </div>
      <div class="legend-item">
        <div class="legend-color" style="background: #FF9800;"></div>
        <span>LWC</span>
      </div>
      <div class="legend-item">
        <div class="legend-color" style="background: #E65100;"></div>
        <span>Aura</span>
      </div>
    </div>
  </div>

  <script>
    const allProjects = ${projectsJson};
    const colorMap = ${colorMapJson};
    const STANDARD_OBJECT_ICONS = {
      account: 'account',
      contact: 'contact',
      case: 'case',
      opportunity: 'opportunity',
      lead: 'lead',
      campaign: 'campaign',
      task: 'task',
      event: 'event',
      contract: 'contract',
      asset: 'product',
      product: 'product',
      order: 'product',
      report: 'report',
      dashboard: 'dashboard'
    };
    const ICON_BASE = 'https://www.lightningdesignsystem.com/assets/icons/standard/';

    // Draggable Panel Logic
    const controlsPanel = document.getElementById('controls');
    const controlsHeader = document.getElementById('controls-header');
    const controlsToggle = document.getElementById('controls-toggle');
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let panelStartX = 0;
    let panelStartY = 0;

    if (controlsHeader) {
      controlsHeader.addEventListener('mousedown', (e) => {
        isDragging = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        const rect = controlsPanel.getBoundingClientRect();
        panelStartX = rect.left;
        panelStartY = rect.top;
        controlsPanel.style.cursor = 'grabbing';
      });

      document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const deltaX = e.clientX - dragStartX;
        const deltaY = e.clientY - dragStartY;
        controlsPanel.style.left = (panelStartX + deltaX) + 'px';
        controlsPanel.style.top = (panelStartY + deltaY) + 'px';
      });

      document.addEventListener('mouseup', () => {
        isDragging = false;
        controlsPanel.style.cursor = 'move';
      });

      // Toggle collapse/expand
      controlsToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const content = document.getElementById('controls-content');
        if (content.style.display === 'none') {
          content.style.display = 'block';
          controlsToggle.textContent = '−';
        } else {
          content.style.display = 'none';
          controlsToggle.textContent = '+';
        }
      });
    }

    // Draggable Legend Logic
    const legendPanel = document.querySelector('.legend');
    const legendHeader = document.querySelector('.legend-header');
    const legendToggle = document.getElementById('legend-toggle');
    let isLegendDragging = false;
    let legendDragStartX = 0;
    let legendDragStartY = 0;
    let legendStartX = 0;
    let legendStartY = 0;

    if (legendHeader && legendPanel) {
      legendHeader.addEventListener('mousedown', (e) => {
        isLegendDragging = true;
        legendDragStartX = e.clientX;
        legendDragStartY = e.clientY;
        const rect = legendPanel.getBoundingClientRect();
        legendStartX = rect.left;
        legendStartY = rect.top;
        legendPanel.style.cursor = 'grabbing';
      });

      document.addEventListener('mousemove', (e) => {
        if (!isLegendDragging) return;
        const deltaX = e.clientX - legendDragStartX;
        const deltaY = e.clientY - legendDragStartY;
        legendPanel.style.right = 'auto';
        legendPanel.style.bottom = 'auto';
        legendPanel.style.left = (legendStartX + deltaX) + 'px';
        legendPanel.style.top = (legendStartY + deltaY) + 'px';
      });

      document.addEventListener('mouseup', () => {
        isLegendDragging = false;
        legendPanel.style.cursor = 'move';
      });

      // Toggle collapse/expand
      legendToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const content = document.querySelector('.legend-content');
        if (content.style.display === 'none') {
          content.style.display = 'block';
          legendToggle.textContent = '−';
        } else {
          content.style.display = 'none';
          legendToggle.textContent = '+';
        }
      });
    }

    function stripObjectSuffix(name) {
      if (!name) return '';
      const cleaned = name.replace(/__c$/i, '').replace(/__r$/i, '');
      return cleaned.toLowerCase();
    }

    function getStandardIconForNode(node) {
      if (!node || node.type !== 'CustomObject') return null;
      const name = stripObjectSuffix(node.label || node.name || node.id || '');
      return STANDARD_OBJECT_ICONS[name] || null;
    }

    function setInfoIcon(iconName) {
      const iconNode = document.getElementById('info-icon');
      if (!iconNode) return;
      if (!iconName) {
        iconNode.innerHTML = '';
        return;
      }
      iconNode.innerHTML = '<img src=\"' + ICON_BASE + iconName + '.svg\" alt=\"\">';
    }

    function populateProjectSelects() {
      const selectHeader = document.getElementById('project-select');
      [selectHeader].forEach(sel => {
        if (!sel) return;
        sel.innerHTML = '';
        allProjects.forEach((d, i) => {
          const opt = document.createElement('option');
          opt.value = i;
          opt.textContent = d.name;
          sel.appendChild(opt);
        });
      });
    }
    if (allProjects && allProjects.length > 0) {
      populateProjectSelects();
    }

    const selectEl = document.getElementById('project-select');
    function onProjectChange(index) {
      if (selectEl) selectEl.value = index;
      switchProject(index);
    }

    // KAIRO-FIX: Add event listeners for dataset change
    if (selectEl) {
      selectEl.addEventListener('change', function() {
        const index = parseInt(this.value);
        if (!Number.isNaN(index) && index >= 0 && index < allProjects.length) {
          onProjectChange(index);
        }
      });
    }

    if (allProjects.length === 0) {
      const emptyEl = document.getElementById('empty-state');
      if (emptyEl) emptyEl.style.display = 'flex';
      const stabOverlay = document.getElementById('stabilization-overlay');
      if (stabOverlay) { stabOverlay.classList.add('hidden'); console.log('[Overlay] hidden (no projects)'); }
      const ds = document.querySelector('.project-switcher');
      if (ds) ds.style.display = 'none';
      const controls = document.getElementById('controls');
      if (controls) controls.style.display = 'none';
    } else {
    const container = document.getElementById('graph');
    console.log('[Overlay] visible (initial load with projects)');
    const nodesDataset = new vis.DataSet(allProjects[0].visNodes);
    const edgesDataset = new vis.DataSet(allProjects[0].visEdges);
    const data = { nodes: nodesDataset, edges: edgesDataset };
    const options = {
      layout: { improvedLayout: false },
      physics: { enabled: true, barnesHut: { gravitationalConstant: -5000, centralGravity: 0.03, springLength: 150, springConstant: 0.005, avoidOverlap: 0.5, damping: 0.5 }, stabilization: { enabled: true, iterations: 500 }, solver: 'barnesHut' },
      nodes: { shape: 'dot', font: { size: 12, color: '#ffffff' }, borderWidth: 2, shapeProperties: { borderDashes: false } },
      edges: { width: 1, smooth: { enabled: false }, arrows: { to: { enabled: true, scaleFactor: 0.5 } } },
      interaction: { tooltipDelay: 0 },
    };
    const network = new vis.Network(container, data, options);

    // Heatmap background (density of nodes) - cheap grid-based rendering
    const heatmapCanvas = document.createElement('canvas');
    heatmapCanvas.id = 'heatmap';
    container.appendChild(heatmapCanvas);
    const heatmapCtx = heatmapCanvas.getContext('2d');

    let heatmapNodes = nodesDataset.get();
    let heatmapMaxSize = Math.max(1, ...heatmapNodes.map(n => n.size || 1));
    let heatmapScheduled = false;
    let heatmapLastCompute = 0;
    let heatmapGrid = new Float32Array(0);
    const HEATMAP_CELL_PX = 18;
    let heatmapGridCols = 0;
    let heatmapGridRows = 0;
    let heatmapCellW = 0;
    let heatmapCellH = 0;
    let heatmapMax = 1;
    let heatmapWidth = 0;
    let heatmapHeight = 0;
    let heatmapDpr = 1;

    function refreshHeatmapCache() {
      heatmapNodes = nodesDataset.get();
      heatmapMaxSize = Math.max(1, ...heatmapNodes.map(n => n.size || 1));
      scheduleHeatmap(true);
    }

    function resizeHeatmapBounds() {
      const rect = container.getBoundingClientRect();
      heatmapWidth = Math.max(1, rect.width);
      heatmapHeight = Math.max(1, rect.height);
      heatmapDpr = window.devicePixelRatio || 1;
      if (heatmapCanvas) {
        heatmapCanvas.width = Math.max(1, Math.floor(heatmapWidth * heatmapDpr));
        heatmapCanvas.height = Math.max(1, Math.floor(heatmapHeight * heatmapDpr));
        heatmapCanvas.style.width = heatmapWidth + 'px';
        heatmapCanvas.style.height = heatmapHeight + 'px';
      }
      if (heatmapCtx) heatmapCtx.setTransform(heatmapDpr, 0, 0, heatmapDpr, 0, 0);
    }

    function scheduleHeatmap(force = false) {
      const now = performance.now();
      if (!force && now - heatmapLastCompute < 200) return;
      if (heatmapScheduled) return;
      heatmapScheduled = true;
      requestAnimationFrame(() => {
        heatmapScheduled = false;
        drawHeatmap(force);
      });
    }

    function computeHeatmap() {
      resizeHeatmapBounds();

      const width = heatmapWidth;
      const height = heatmapHeight;
      heatmapGridCols = Math.max(1, Math.ceil(width / HEATMAP_CELL_PX));
      heatmapGridRows = Math.max(1, Math.ceil(height / HEATMAP_CELL_PX));
      heatmapCellW = width / heatmapGridCols;
      heatmapCellH = height / heatmapGridRows;
      const grid = new Float32Array(heatmapGridCols * heatmapGridRows);

      const positions = network.getPositions(heatmapNodes.map(n => n.id));
      const scale = network.getScale();
      for (const node of heatmapNodes) {
        const pos = positions[node.id];
        if (!pos) continue;
        const dom = network.canvasToDOM(pos);
        const size = node.size || 10;
        const intensity = Math.min(3, 0.5 + size / heatmapMaxSize);
        const radius = Math.max(2, size * scale);
        const minX = Math.max(0, Math.floor((dom.x - radius) / heatmapCellW));
        const maxX = Math.min(heatmapGridCols - 1, Math.floor((dom.x + radius) / heatmapCellW));
        const minY = Math.max(0, Math.floor((dom.y - radius) / heatmapCellH));
        const maxY = Math.min(heatmapGridRows - 1, Math.floor((dom.y + radius) / heatmapCellH));

        for (let y = minY; y <= maxY; y++) {
          const y0 = y * heatmapCellH;
          const y1 = y0 + heatmapCellH;
          const dy = dom.y < y0 ? y0 - dom.y : (dom.y > y1 ? dom.y - y1 : 0);
          for (let x = minX; x <= maxX; x++) {
            const x0 = x * heatmapCellW;
            const x1 = x0 + heatmapCellW;
            const dx = dom.x < x0 ? x0 - dom.x : (dom.x > x1 ? dom.x - x1 : 0);
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > radius) continue;
            const falloff = 1 - dist / radius;
            const idx = y * heatmapGridCols + x;
            grid[idx] += intensity * (0.4 + 0.6 * falloff);
          }
        }
      }

      let max = 0;
      for (let i = 0; i < grid.length; i++) {
        if (grid[i] > max) max = grid[i];
      }
      heatmapMax = Math.max(1, max);
      heatmapGrid = grid;
      heatmapLastCompute = performance.now();
    }

    function drawHeatmap(force = false) {
      if (!heatmapCtx) return;
      if (force || performance.now() - heatmapLastCompute > 200) computeHeatmap();
      if (!heatmapGrid.length) return;
      heatmapCtx.save();
      heatmapCtx.globalCompositeOperation = 'source-over';
      heatmapCtx.globalAlpha = 0.45;
      heatmapCtx.clearRect(0, 0, heatmapWidth, heatmapHeight);
      for (let y = 0; y < heatmapGridRows; y++) {
        for (let x = 0; x < heatmapGridCols; x++) {
          const value = heatmapGrid[y * heatmapGridCols + x];
          if (value <= 0) continue;
          const alpha = Math.min(0.45, value / heatmapMax);
          heatmapCtx.fillStyle = 'rgba(255, 64, 129, ' + alpha.toFixed(3) + ')';
          heatmapCtx.fillRect(x * heatmapCellW, y * heatmapCellH, heatmapCellW + 0.5, heatmapCellH + 0.5);
        }
      }
      // Grid overlay
      heatmapCtx.globalAlpha = 0.15;
      heatmapCtx.strokeStyle = 'rgba(255, 64, 129, 0.2)';
      heatmapCtx.lineWidth = 1;
      for (let x = 0; x <= heatmapGridCols; x++) {
        const px = Math.round(x * heatmapCellW) + 0.5;
        heatmapCtx.beginPath();
        heatmapCtx.moveTo(px, 0);
        heatmapCtx.lineTo(px, heatmapHeight);
        heatmapCtx.stroke();
      }
      for (let y = 0; y <= heatmapGridRows; y++) {
        const py = Math.round(y * heatmapCellH) + 0.5;
        heatmapCtx.beginPath();
        heatmapCtx.moveTo(0, py);
        heatmapCtx.lineTo(heatmapWidth, py);
        heatmapCtx.stroke();
      }
      heatmapCtx.restore();
    }

    window.addEventListener('resize', () => scheduleHeatmap(true));
    network.on('dragEnd', () => scheduleHeatmap(true));
    network.on('zoom', () => scheduleHeatmap(true));
    network.on('afterDrawing', () => scheduleHeatmap());
    scheduleHeatmap(true);

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
    function updateZoomIndicator(scale) {
      const el = document.getElementById('legend-zoom-value');
      if (el) el.textContent = scale.toFixed(2);
    }
    network.on('zoom', function(params) {
      updateLabelsForZoom(params.scale);
      updateZoomIndicator(params.scale);
    });
    const initialScale = network.getScale();
    updateLabelsForZoom(initialScale);
    updateZoomIndicator(initialScale);

    let currentIndex = 0;
    let currentNodes = allProjects[0].nodes;
    let allNodes = allProjects[0].visNodes.slice();
    let allEdges = allProjects[0].visEdges.slice();
    let currentRecommended = { ...allProjects[0].recommended, minWeight: 3 };
    let connectionCounts = new Map();
    let shouldFreeze = allProjects[0].visNodes.length <= 900;
    const DEFAULT_MIN_MEMBERS = 3;

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
      const s = allProjects[index].stats;
      document.getElementById('stat-components').textContent = s.totalComponents;
      document.getElementById('stat-deps').textContent = s.totalDependencies;
      document.getElementById('stat-objects').textContent = s.componentsByType.CustomObject || 0;
      document.getElementById('stat-apex').textContent = (s.componentsByType.ApexClass || 0) + (s.componentsByType.ApexTrigger || 0);
    }

    function switchProject(index) {
      currentIndex = index;
      const d = allProjects[index];
      currentNodes = d.nodes;
      allNodes = d.visNodes.slice();
      allEdges = d.visEdges.slice();
      currentRecommended = d.recommended;
      shouldFreeze = d.visNodes.length <= 900;
      recomputeConnectionCounts();
      updateStats(index);
      const overlay = document.getElementById('stabilization-overlay');
      if (overlay) { overlay.classList.remove('hidden'); console.log('[Overlay] shown (switch project)'); }
      applyPhysicsMode();
      resetView();
    }

    function weightStats(edges) {
      let min = Infinity;
      let max = -Infinity;
      edges.forEach(e => {
        const w = e.weight || 0;
        if (w < min) min = w;
        if (w > max) max = w;
      });
      if (min === Infinity) min = 0;
      if (max === -Infinity) max = 0;
      return { min, max, range: Math.max(1e-6, max - min) };
    }

    function encodeEdges(edges) {
      const { min, max, range } = weightStats(edges);
      return edges.map(e => {
        const w = e.weight || 0;
        const n = Math.min(1, Math.max(0, (w - min) / range));
        const baseLength = e.baseLength != null ? e.baseLength : e.length;
      let color = '#9C27B0';
      let opacity = 0.35 + 0.65 * n;
        let width = 0.5 + 3.5 * n;
        let length = baseLength;
        return { ...e, color: { color, opacity }, width, length, dashes: false };
      });
    }

    selectEl.addEventListener('change', function() { onProjectChange(parseInt(this.value, 10)); });

    function hideStabilizationOverlay() {
      const overlay = document.getElementById('stabilization-overlay');
      if (overlay) { overlay.classList.add('hidden'); console.log('[Overlay] hidden (stabilization done)'); }
    }

    function applyPhysicsMode() {
      if (shouldFreeze) {
        network.once('stabilized', function() {
          hideStabilizationOverlay();
          setTimeout(function() { network.setOptions({ physics: false }); }, 500);
        });
      } else {
        network.setOptions({ physics: { enabled: true, stabilization: { enabled: false } } });
        setTimeout(hideStabilizationOverlay, 3000);
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
          setInfoIcon(getStandardIconForNode(node));
          infoPanel.classList.add('visible');
        }
      } else {
        infoPanel.classList.remove('visible');
        setInfoIcon(null);
      }
    });

    network.on('doubleClick', function(params) {
      const scale = network.getScale();
      let pos = network.getViewPosition();
      if (params.nodes.length > 0) {
        const nodePos = network.getPositions()[params.nodes[0]];
        if (nodePos) pos = { x: nodePos.x, y: nodePos.y };
      }
      const newScale = Math.min(scale * 1.4, 5);
      network.moveTo({
        scale: newScale,
        position: pos,
        animation: { duration: 200, easingFunction: 'easeInOutQuad' }
      });
    });

    function pruneSmallComponents(nodesArr, edgesArr, minMembers) {
      if (minMembers <= 1) return { nodes: nodesArr, edges: edgesArr };
      const adj = new Map();
      nodesArr.forEach(n => adj.set(n.id, new Set()));
      edgesArr.forEach(e => {
        if (adj.has(e.from) && adj.has(e.to)) {
          adj.get(e.from).add(e.to);
          adj.get(e.to).add(e.from);
        }
      });
      const visited = new Set();
      const keep = new Set();
      nodesArr.forEach(n => {
        if (visited.has(n.id)) return;
        const stack = [n.id];
        const comp = [];
        visited.add(n.id);
        while (stack.length) {
          const v = stack.pop();
          comp.push(v);
          adj.get(v)?.forEach(nb => {
            if (!visited.has(nb)) {
              visited.add(nb);
              stack.push(nb);
            }
          });
        }
        if (comp.length >= minMembers) comp.forEach(id => keep.add(id));
      });
      const prunedNodes = nodesArr.filter(n => keep.has(n.id));
      const prunedIds = new Set(prunedNodes.map(n => n.id));
      const prunedEdges = edgesArr.filter(e => prunedIds.has(e.from) && prunedIds.has(e.to));
      return { nodes: prunedNodes, edges: prunedEdges };
    }

    function applyFilters() {
      const checkboxes = document.querySelectorAll('#controls input[type=\"checkbox\"]');
      const selectedTypes = Array.from(checkboxes)
        .filter(cb => cb.checked)
        .map(cb => cb.value);

      const minConn = parseInt(document.getElementById('min-connections').value, 10) || 0;
      const minWeight = parseInt(document.getElementById('min-weight').value, 10) || 0;
      const minMembers = parseInt(document.getElementById('min-members').value, 10) || 1;

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

      const connected = pruneSmallComponents(filteredNodes, filteredEdges, minMembers);
      const finalNodeIds = new Set(connected.nodes.map(n => n.id));
      filteredEdges = connected.edges.filter(edge => finalNodeIds.has(edge.from) && finalNodeIds.has(edge.to));

      const positions = network.getPositions();
      const nodesWithPositions = filteredNodes.map(node => ({
        ...node,
        x: positions[node.id]?.x,
        y: positions[node.id]?.y,
        fixed: { x: false, y: false },
      }));

      nodesDataset.clear();
      edgesDataset.clear();
      nodesDataset.add(nodesWithPositions.filter(n => finalNodeIds.has(n.id)));
      edgesDataset.add(encodeEdges(filteredEdges));
      refreshHeatmapCache();
      updateLabelsForZoom(network.getScale());
    }

    function filterByType() {
      applyFilters();
    }

    function filterByConnections(val) {
      applyFilters();
    }

    function filterByMembers(val) {
      applyFilters();
    }

    function filterByWeight(minWeight) {
      document.getElementById('weight-description').textContent = weightDescription(minWeight);
      applyFilters();
    }

    function applyRecommended() {
      const minConnEl = document.getElementById('min-connections');
      const minWeightEl = document.getElementById('min-weight');
      if (minConnEl) minConnEl.value = currentRecommended.minConnections;
      if (minWeightEl) minWeightEl.value = currentRecommended.minWeight;
      const minMembersEl = document.getElementById('min-members');
      if (minMembersEl) minMembersEl.value = DEFAULT_MIN_MEMBERS;
      filterByWeight(currentRecommended.minWeight);
    }

    function updatePhysics() {
      const weakThreshold = parseFloat(document.getElementById('weak-threshold').value);
      const weakRepulsion = parseFloat(document.getElementById('weak-repulsion').value);


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

        return { ...edge, length: springLength, baseLength: springLength };
      });

      edgesDataset.clear();
      edgesDataset.add(encodeEdges(updatedEdges));
      refreshHeatmapCache();

      network.setOptions({ physics: { enabled: true } });
      if (shouldFreeze) {
        setTimeout(() => {
          network.setOptions({ physics: { enabled: false } });
        }, 5000);
      }
    }

    function resetView() {
      const d = allProjects[currentIndex];
      const searchInput = document.getElementById('search-input');
      if (searchInput) searchInput.value = '';

      const checkboxes = document.querySelectorAll('#controls input[type=\"checkbox\"]');
      checkboxes.forEach(cb => { cb.checked = true; });

      const minWeightEl = document.getElementById('min-weight');
      if (minWeightEl) minWeightEl.value = currentRecommended.minWeight;
      document.getElementById('weight-description').textContent = weightDescription(currentRecommended.minWeight);

      const weakThresholdEl = document.getElementById('weak-threshold');
      const weakRepulsionEl = document.getElementById('weak-repulsion');
      if (weakThresholdEl) weakThresholdEl.value = 3.5;
      if (weakRepulsionEl) weakRepulsionEl.value = 40;

      document.getElementById('min-connections').value = currentRecommended.minConnections;
      applyFilters();
      network.fit();
      updatePhysics();
    }

    // Apply default filters on initial load
    resetView();

    document.getElementById('search-input')?.addEventListener('input', function(e) {
      const target = e.currentTarget;
      const term = ((target && target.value) || '').toLowerCase();
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

    // Animated slider tooltips
    document.querySelectorAll('.slider-track-area').forEach(area => {
      const input = area.querySelector('input[type="range"]');
      const tooltipSpan = area.querySelector('.sliderValue span');
      if (!input || !tooltipSpan) return;

      function positionTooltip() {
        const min = parseFloat(input.min);
        const max = parseFloat(input.max);
        const val = parseFloat(input.value);
        const pct = ((val - min) / (max - min)) * 100;
        tooltipSpan.style.left = pct + '%';
        tooltipSpan.textContent = (input.step && parseFloat(input.step) < 1)
          ? val.toFixed(1) : String(Math.round(val));
      }

      positionTooltip();

      input.addEventListener('input', () => {
        positionTooltip();
        tooltipSpan.classList.add('show');
      });

      input.addEventListener('mousedown', () => {
        positionTooltip();
        tooltipSpan.classList.add('show');
      });

      input.addEventListener('mouseup', () => {
        setTimeout(() => tooltipSpan.classList.remove('show'), 160);
      });

      input.addEventListener('touchstart', () => {
        positionTooltip();
        tooltipSpan.classList.add('show');
      }, { passive: true });

      input.addEventListener('touchend', () => {
        setTimeout(() => tooltipSpan.classList.remove('show'), 160);
      });

      input.addEventListener('blur', () => {
        tooltipSpan.classList.remove('show');
      });
    });
    }
  </script>
</body>
</html>`;
  }
}
