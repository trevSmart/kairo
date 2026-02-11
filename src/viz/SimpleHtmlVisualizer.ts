import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import type { AnalysisResult, Dependency } from '../types.js';
import { DependencyWeightCalculator } from '../utils/DependencyWeightCalculator.js';

/**
 * Simple HTML visualizer that creates a list-based view instead of a graph.
 * More reliable for large datasets, easier to debug.
 */
export class SimpleHtmlVisualizer {
  generate(result: AnalysisResult, outputPath: string): void {
    const dir = dirname(outputPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Count connections for each component and track weighted dependencies
    const connectionCounts = new Map<string, number>();
    const incomingConnections = new Map<string, Array<{ id: string; weight: number }>>();
    const outgoingConnections = new Map<string, Array<{ id: string; weight: number }>>();
    const dependencyMap = new Map<string, Dependency>();

    result.graph.dependencies.forEach(dep => {
      const weight = dep.weight ?? DependencyWeightCalculator.calculate(dep);
      const depKey = `${dep.from}->${dep.to}`;
      dependencyMap.set(depKey, dep);

      connectionCounts.set(dep.from, (connectionCounts.get(dep.from) || 0) + 1);
      connectionCounts.set(dep.to, (connectionCounts.get(dep.to) || 0) + 1);

      if (!outgoingConnections.has(dep.from)) outgoingConnections.set(dep.from, []);
      outgoingConnections.get(dep.from)!.push({ id: dep.to, weight });

      if (!incomingConnections.has(dep.to)) incomingConnections.set(dep.to, []);
      incomingConnections.get(dep.to)!.push({ id: dep.from, weight });
    });

    // Sort components by connection count
    const sortedComponents = Array.from(result.graph.components.values())
      .map(comp => ({
        ...comp,
        connections: connectionCounts.get(comp.id) || 0,
        incoming: incomingConnections.get(comp.id) || [],
        outgoing: outgoingConnections.get(comp.id) || [],
      }))
      .sort((a, b) => b.connections - a.connections);

    const html = this.generateHtml(sortedComponents, result.stats);
    writeFileSync(outputPath, html);
    console.log(`📊 Simple visualization saved to: ${outputPath}`);
  }

  private generateHtml(
    components: Array<{
      id: string;
      name: string;
      type: string;
      label?: string;
      connections: number;
      incoming: Array<{ id: string; weight: number }>;
      outgoing: Array<{ id: string; weight: number }>;
    }>,
    stats: AnalysisResult['stats']
  ): string {
    const componentsHtml = components
      .map(
        comp => {
          // Helper to get weight badge class
          const getWeightClass = (w: number) => {
            if (w >= 9) return 'weight-critical';
            if (w >= 7) return 'weight-business';
            if (w >= 5) return 'weight-structure';
            if (w >= 3) return 'weight-operations';
            return 'weight-infra';
          };

          // Sort by weight descending
          const sortedOutgoing = comp.outgoing.slice().sort((a, b) => b.weight - a.weight);
          const sortedIncoming = comp.incoming.slice().sort((a, b) => b.weight - a.weight);

          return `
      <div class="component-card" data-type="${comp.type}" data-connections="${comp.connections}">
        <div class="component-header">
          <span class="component-type type-${comp.type}">${comp.type}</span>
          <span class="component-name">${comp.name}</span>
          <span class="component-connections">${comp.connections} connections</span>
        </div>
        ${comp.label ? `<div class="component-label">${comp.label}</div>` : ''}
        <div class="component-details">
          <div class="detail-section">
            <strong>Depends on (${comp.outgoing.length}):</strong>
            ${comp.outgoing.length > 0 ? `<div class="dependency-list">${sortedOutgoing.slice(0, 10).map(dep => `<span class="dep-item ${getWeightClass(dep.weight)}" title="Weight: ${dep.weight}">${dep.id.split(':')[1] || dep.id}</span>`).join('')}${comp.outgoing.length > 10 ? `<span class="more">+${comp.outgoing.length - 10} more</span>` : ''}</div>` : '<em>none</em>'}
          </div>
          <div class="detail-section">
            <strong>Used by (${comp.incoming.length}):</strong>
            ${comp.incoming.length > 0 ? `<div class="dependency-list">${sortedIncoming.slice(0, 10).map(dep => {
              const type = (dep.id.split(':')[0] || 'Unknown').replace(/\\s+/g, '');
              const label = dep.id.split(':')[1] || dep.id;
              return `<span class="dep-item used-by type-${type}" title="${type}">${label}</span>`;
            }).join('')}${comp.incoming.length > 10 ? `<span class="more">+${comp.incoming.length - 10} more</span>` : ''}</div>` : '<em>none</em>'}
          </div>
        </div>
      </div>
    `;
        }
      )
      .join('');

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Kairo - Salesforce Metadata Analysis</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      margin: 0;
      padding: 0;
      background: #f5f5f5;
    }
    #header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 30px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      position: sticky;
      top: 0;
      z-index: 100;
    }
    h1 { margin: 0 0 15px 0; font-size: 32px; }
    #stats {
      display: flex;
      gap: 30px;
      font-size: 14px;
      flex-wrap: wrap;
    }
    .stat { display: flex; align-items: center; gap: 8px; }
    .stat-value { font-size: 24px; font-weight: bold; }

    #controls {
      background: white;
      padding: 20px 30px;
      box-shadow: 0 2px 5px rgba(0,0,0,0.1);
      display: flex;
      gap: 20px;
      flex-wrap: wrap;
      align-items: center;
    }
    .control-group { display: flex; gap: 10px; align-items: center; }
    label { font-weight: 600; font-size: 14px; }
    input[type="text"] {
      padding: 8px 12px;
      border: 2px solid #ddd;
      border-radius: 6px;
      font-size: 14px;
      min-width: 250px;
    }
    input[type="text"]:focus {
      outline: none;
      border-color: #667eea;
    }
    select {
      padding: 8px 12px;
      border: 2px solid #ddd;
      border-radius: 6px;
      font-size: 14px;
      cursor: pointer;
    }
    input[type="range"] {
      width: 150px;
    }

    #container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 30px;
    }
    #results-info {
      margin-bottom: 20px;
      font-size: 14px;
      color: #666;
    }

    .component-card {
      background: white;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 15px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .component-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 16px rgba(0,0,0,0.12);
    }
    .component-header {
      display: flex;
      align-items: center;
      gap: 15px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    .component-type {
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .type-CustomObject { background: #DA70D6; color: white; }
    .type-ApexClass { background: #00BCD4; color: white; }
    .type-ApexTrigger { background: #1565C0; color: white; }
    .type-Flow { background: #9C27B0; color: white; }
    .type-LightningWebComponent { background: #CDDC39; color: white; }
    .type-AuraComponent { background: #CDDC39; color: white; }
    .type-Unknown { background: #757575; color: white; }

    .component-name {
      font-size: 18px;
      font-weight: 600;
      color: #333;
      flex: 1;
    }
    .component-connections {
      font-size: 14px;
      color: #666;
      background: #f0f0f0;
      padding: 4px 12px;
      border-radius: 12px;
    }
    .component-label {
      color: #666;
      font-size: 14px;
      margin-bottom: 12px;
      font-style: italic;
    }
    .component-details {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      margin-top: 15px;
      padding-top: 15px;
      border-top: 1px solid #eee;
    }
    .detail-section { font-size: 13px; }
    .detail-section strong { display: block; margin-bottom: 8px; color: #333; }
    .dependency-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .dep-item {
      background: #f5f5f5;
      padding: 3px 10px;
      border-radius: 4px;
      font-size: 12px;
      color: #555;
      border-left: 3px solid transparent;
    }
    .dep-item.weight-critical {
      background: #fce4ec;
      border-left-color: #E91E63;
      color: #880E4F;
      font-weight: 600;
    }
    .dep-item.weight-business {
      background: #f3e5f5;
      border-left-color: #9C27B0;
      color: #4A148C;
      font-weight: 600;
    }
    .dep-item.weight-structure {
      background: #e3f2fd;
      border-left-color: #2196F3;
      color: #0D47A1;
    }
    .dep-item.weight-operations {
      background: #f5f5f5;
      border-left-color: #757575;
      color: #424242;
    }
    .dep-item.weight-infra {
      background: #fafafa;
      border-left-color: #e0e0e0;
      color: #9e9e9e;
    }
    .dep-item.used-by {
      font-weight: 600;
    }
    .dep-item.used-by.type-CustomObject {
      background: #f3e5f5;
      border-left-color: #DA70D6;
      color: #4a148c;
    }
    .dep-item.used-by.type-ApexClass {
      background: #e0f7fa;
      border-left-color: #00BCD4;
      color: #0d47a1;
    }
    .dep-item.used-by.type-ApexTrigger {
      background: #f1f8e9;
      border-left-color: #1565C0;
      color: #0d47a1;
    }
    .dep-item.used-by.type-Flow {
      background: #f3e5f5;
      border-left-color: #9C27B0;
      color: #4a148c;
    }
    .dep-item.used-by.type-LightningWebComponent,
    .dep-item.used-by.type-AuraComponent {
      background: #f1f8e9;
      border-left-color: #CDDC39;
      color: #33691e;
    }
    .dep-item.used-by.type-Unknown {
      background: #f5f5f5;
      border-left-color: #9e9e9e;
      color: #616161;
    }
    .more {
      color: #667eea;
      font-size: 12px;
      font-weight: 600;
    }

    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div id="header">
    <h1>🎯 Kairo - Salesforce Metadata Analysis</h1>
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

  <div id="controls">
    <div class="control-group">
      <label for="search">🔍 Search:</label>
      <input type="text" id="search" placeholder="Type component name...">
    </div>
    <div class="control-group">
      <label for="type-filter">Type:</label>
      <select id="type-filter">
        <option value="all">All Types</option>
        <option value="CustomObject">Custom Objects</option>
        <option value="ApexClass">Apex Classes</option>
        <option value="ApexTrigger">Apex Triggers</option>
        <option value="Flow">Flows</option>
        <option value="LightningWebComponent">LWC</option>
        <option value="AuraComponent">Aura</option>
      </select>
    </div>
    <div class="control-group">
      <label for="min-conn">Min Connections:</label>
      <input type="range" id="min-conn" min="0" max="20" value="1">
      <span id="min-conn-value">1</span>
    </div>
    <div class="control-group">
      <label for="min-weight">Show only high-value dependencies:</label>
      <input type="checkbox" id="show-process-only">
      <label for="show-process-only" style="font-weight: normal; margin-left: 5px;">Business Processes (≥7)</label>
    </div>
  </div>

  <div id="container">
    <div id="results-info"></div>
    <div id="components">
      ${componentsHtml}
    </div>
  </div>

  <script>
    const allCards = document.querySelectorAll('.component-card');
    const searchInput = document.getElementById('search');
    const typeFilter = document.getElementById('type-filter');
    const minConnSlider = document.getElementById('min-conn');
    const minConnValue = document.getElementById('min-conn-value');
    const resultsInfo = document.getElementById('results-info');

    function applyFilters() {
      const searchTerm = searchInput.value.toLowerCase();
      const selectedType = typeFilter.value;
      const minConn = parseInt(minConnSlider.value);

      let visibleCount = 0;

      allCards.forEach(card => {
        const name = card.querySelector('.component-name').textContent.toLowerCase();
        const type = card.getAttribute('data-type');
        const connections = parseInt(card.getAttribute('data-connections'));

        const matchesSearch = searchTerm === '' || name.includes(searchTerm);
        const matchesType = selectedType === 'all' || type === selectedType;
        const matchesConnections = connections >= minConn;

        if (matchesSearch && matchesType && matchesConnections) {
          card.classList.remove('hidden');
          visibleCount++;
        } else {
          card.classList.add('hidden');
        }
      });

      resultsInfo.textContent = \`Showing \${visibleCount} of \${allCards.length} components\`;
    }

    const processOnlyCheckbox = document.getElementById('show-process-only');

    searchInput.addEventListener('input', applyFilters);
    typeFilter.addEventListener('change', applyFilters);
    minConnSlider.addEventListener('input', function() {
      minConnValue.textContent = this.value;
      applyFilters();
    });
    processOnlyCheckbox.addEventListener('change', function() {
      // Hide low-weight dependencies when checked
      const depItems = document.querySelectorAll('.dep-item');
      depItems.forEach(item => {
        if (this.checked) {
          // Only show critical and business weight items (≥7)
          if (!item.classList.contains('weight-critical') && !item.classList.contains('weight-business')) {
            item.style.display = 'none';
          }
        } else {
          item.style.display = '';
        }
      });
    });

    // Initial display
    applyFilters();
  </script>
</body>
</html>`;
  }
}
