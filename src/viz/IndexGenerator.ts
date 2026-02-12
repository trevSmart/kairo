import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import type { AnalysisResult } from '../types.js';

export type DatasetEntry = { id: string; name: string; source?: string };

export class IndexGenerator {
  generateAppHomeHtml(datasets: DatasetEntry[]): string {
    const datasetRows = datasets
      .map(
        ds => `
      <div class="dataset-row" data-id="${ds.id}">
        <div class="dataset-info">
          <span class="dataset-name">${ds.name}</span>
          <span class="dataset-id">${ds.id}</span>
        </div>
        <div class="dataset-actions">
          <a href="/list/${ds.id}" class="btn btn-list">📋 List</a>
          <a href="/graph/${ds.id}" class="btn btn-graph">🕸️ Graph</a>
          <button type="button" class="btn btn-remove" onclick="removeDataset('${ds.id}', '${ds.name.replace(/'/g, "\\'")}')">Remove</button>
        </div>
      </div>`
      )
      .join('');

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Kairo - Dataset Manager</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 40px 20px; }
    .container { max-width: 800px; margin: 0 auto; }
    h1 { color: white; font-size: 36px; margin-bottom: 8px; }
    .subtitle { color: rgba(255,255,255,0.9); font-size: 16px; margin-bottom: 30px; }
    .panel { background: white; border-radius: 16px; padding: 24px; margin-bottom: 20px; box-shadow: 0 10px 40px rgba(0,0,0,0.15); }
    .panel h2 { font-size: 18px; margin-bottom: 16px; color: #333; }
    .add-form { display: flex; flex-direction: column; gap: 12px; }
    .add-form input { padding: 10px 14px; border: 2px solid #ddd; border-radius: 8px; font-size: 14px; }
    .add-form input:focus { outline: none; border-color: #667eea; }
    .add-form button { padding: 12px; background: #667eea; color: white; border: none; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 14px; }
    .add-form button:hover { background: #5568d3; }
    .dataset-row { display: flex; justify-content: space-between; align-items: center; padding: 16px; border: 1px solid #eee; border-radius: 8px; margin-bottom: 10px; background: #fafafa; }
    .dataset-row:last-child { margin-bottom: 0; }
    .dataset-info { display: flex; flex-direction: column; gap: 4px; }
    .dataset-name { font-weight: 600; color: #333; }
    .dataset-id { font-size: 12px; color: #666; }
    .dataset-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .btn { padding: 8px 16px; border-radius: 6px; font-size: 13px; font-weight: 500; text-decoration: none; cursor: pointer; border: none; }
    .btn-list { background: #4CAF50; color: white; }
    .btn-list:hover { background: #43a047; }
    .btn-graph { background: #2196F3; color: white; }
    .btn-graph:hover { background: #1e88e5; }
    .btn-remove { background: #f44336; color: white; }
    .btn-remove:hover { background: #e53935; }
    .empty-state { color: #666; text-align: center; padding: 40px 20px; }
    .empty-state p { margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎯 Kairo</h1>
    <p class="subtitle">Analyze Salesforce metadata. Add datasets and open list or graph view to run analysis on demand.</p>

    <div class="panel">
      <h2>Add dataset</h2>
      <form class="add-form" onsubmit="return addDataset(event)">
        <input type="text" name="id" placeholder="ID (e.g. myproject)" required>
        <input type="text" name="name" placeholder="Display name" required>
        <input type="text" name="source" placeholder="Source path (e.g. ./force-app/main/default)" required>
        <button type="submit">Add dataset</button>
      </form>
    </div>

    <div class="panel">
      <h2>Datasets</h2>
      <div id="dataset-list">
        ${datasets.length === 0 ? '<div class="empty-state"><p>No datasets yet.</p><p>Add one above to get started.</p></div>' : datasetRows}
      </div>
    </div>
  </div>

  <script>
    async function addDataset(e) {
      e.preventDefault();
      const form = e.target;
      const body = JSON.stringify({
        id: form.id.value.trim(),
        name: form.name.value.trim(),
        source: form.source.value.trim()
      });
      const res = await fetch('/api/datasets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (!res.ok) { alert('Failed to add dataset'); return false; }
      location.reload();
      return false;
    }
    async function removeDataset(id, name) {
      if (!confirm('Remove dataset "' + name + '"?')) return;
      const res = await fetch('/api/datasets/' + encodeURIComponent(id), { method: 'DELETE' });
      if (!res.ok) { alert('Failed to remove dataset'); return; }
      location.reload();
    }
  </script>
</body>
</html>`;
  }

  generate(result: AnalysisResult, outputPath: string): void {
    const dir = dirname(outputPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const html = this.generateHtml(result.stats);
    writeFileSync(outputPath, html);
    console.log(`📄 Index page saved to: ${outputPath}`);
  }

  generateMulti(results: AnalysisResult[], names: string[], outputPath: string): void {
    const dir = dirname(outputPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const html = this.generateHtmlMulti(results, names);
    writeFileSync(outputPath, html);
    console.log(`📄 Index page (multi-dataset) saved to: ${outputPath}`);
  }

  private generateHtmlMulti(results: AnalysisResult[], names: string[]): string {
    const totalComponents = results.reduce((s, r) => s + r.stats.totalComponents, 0);
    const totalDeps = results.reduce((s, r) => s + r.stats.totalDependencies, 0);
    const datasetList = names.map((name, i) => `${name} (${results[i].stats.totalComponents} components)`).join(', ');
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Kairo - Multi-dataset analysis</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .container { max-width: 900px; width: 100%; }
    h1 { color: white; font-size: 48px; margin-bottom: 16px; text-align: center; }
    .subtitle { color: rgba(255,255,255,0.9); font-size: 18px; text-align: center; margin-bottom: 40px; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-bottom: 40px; }
    .stat-card { background: rgba(255,255,255,0.2); backdrop-filter: blur(10px); border-radius: 12px; padding: 20px; text-align: center; color: white; }
    .stat-value { font-size: 36px; font-weight: bold; margin-bottom: 8px; }
    .stat-label { font-size: 14px; opacity: 0.9; }
    .views-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
    .view-card { background: white; border-radius: 16px; padding: 30px; box-shadow: 0 10px 40px rgba(0,0,0,0.2); text-decoration: none; color: inherit; display: block; transition: transform 0.2s, box-shadow 0.2s; }
    .view-card:hover { transform: translateY(-4px); box-shadow: 0 15px 50px rgba(0,0,0,0.3); }
    .view-icon { font-size: 48px; margin-bottom: 16px; }
    .view-title { font-size: 24px; font-weight: bold; margin-bottom: 12px; color: #333; }
    .view-description { font-size: 14px; color: #666; line-height: 1.6; }
    .dataset-list { font-size: 13px; color: #555; margin-top: 12px; }
    footer { text-align: center; color: rgba(255,255,255,0.8); margin-top: 40px; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Kairo – Multi-dataset</h1>
    <p class="subtitle">Switch between datasets in the graph view</p>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-value">${results.length}</div><div class="stat-label">Datasets</div></div>
      <div class="stat-card"><div class="stat-value">${totalComponents.toLocaleString()}</div><div class="stat-label">Total components</div></div>
      <div class="stat-card"><div class="stat-value">${totalDeps.toLocaleString()}</div><div class="stat-label">Total dependencies</div></div>
    </div>
    <div class="views-grid">
      <a href="dependency-graph.html" class="view-card">
        <div class="view-icon">🕸️</div>
        <div class="view-title">Graph view</div>
        <div class="view-description">
          Interactive dependency graph. Use the <strong>Dataset</strong> dropdown in the header to switch between: ${datasetList}.
        </div>
      </a>
    </div>
    <footer>Generated with Kairo • ${new Date().toLocaleString()}</footer>
  </div>
</body>
</html>`;
  }

  private generateHtml(stats: AnalysisResult['stats']): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Kairo - Salesforce Metadata Analysis</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      max-width: 900px;
      width: 100%;
    }
    h1 {
      color: white;
      font-size: 48px;
      margin-bottom: 16px;
      text-align: center;
    }
    .subtitle {
      color: rgba(255,255,255,0.9);
      font-size: 18px;
      text-align: center;
      margin-bottom: 40px;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 15px;
      margin-bottom: 40px;
    }
    .stat-card {
      background: rgba(255,255,255,0.2);
      backdrop-filter: blur(10px);
      border-radius: 12px;
      padding: 20px;
      text-align: center;
      color: white;
    }
    .stat-value {
      font-size: 36px;
      font-weight: bold;
      margin-bottom: 8px;
    }
    .stat-label {
      font-size: 14px;
      opacity: 0.9;
    }
    .views-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 20px;
    }
    .view-card {
      background: white;
      border-radius: 16px;
      padding: 30px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
      transition: transform 0.2s, box-shadow 0.2s;
      cursor: pointer;
      text-decoration: none;
      color: inherit;
      display: block;
    }
    .view-card:hover {
      transform: translateY(-4px);
      box-shadow: 0 15px 50px rgba(0,0,0,0.3);
    }
    .view-icon {
      font-size: 48px;
      margin-bottom: 16px;
    }
    .view-title {
      font-size: 24px;
      font-weight: bold;
      margin-bottom: 12px;
      color: #333;
    }
    .view-description {
      font-size: 14px;
      color: #666;
      line-height: 1.6;
      margin-bottom: 16px;
    }
    .view-features {
      list-style: none;
      font-size: 13px;
      color: #555;
    }
    .view-features li {
      padding: 4px 0;
      padding-left: 20px;
      position: relative;
    }
    .view-features li:before {
      content: "✓";
      position: absolute;
      left: 0;
      color: #667eea;
      font-weight: bold;
    }
    .view-badge {
      display: inline-block;
      background: #667eea;
      color: white;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      margin-top: 12px;
    }
    .view-badge.recommended {
      background: #4CAF50;
    }
    .view-badge.experimental {
      background: #FF9800;
    }
    footer {
      text-align: center;
      color: rgba(255,255,255,0.8);
      margin-top: 40px;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎯 Kairo Analysis Results</h1>
    <p class="subtitle">Salesforce Org Metadata Analysis</p>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">${stats.totalComponents.toLocaleString()}</div>
        <div class="stat-label">Components</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.totalDependencies.toLocaleString()}</div>
        <div class="stat-label">Dependencies</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.componentsByType.CustomObject || 0}</div>
        <div class="stat-label">Objects</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.componentsByType.ApexClass || 0}</div>
        <div class="stat-label">Apex Classes</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.componentsByType.LightningWebComponent || 0}</div>
        <div class="stat-label">LWC</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.componentsByType.AuraComponent || 0}</div>
        <div class="stat-label">Aura</div>
      </div>
    </div>

    <div class="views-grid">
      <a href="component-list.html" class="view-card">
        <div class="view-icon">📋</div>
        <div class="view-title">List View</div>
        <div class="view-description">
          Browse all components as an interactive, searchable list with detailed dependency information.
        </div>
        <ul class="view-features">
          <li>Fast and responsive</li>
          <li>Advanced search and filters</li>
          <li>Shows all ${stats.totalComponents.toLocaleString()} components</li>
          <li>Detailed dependency breakdown</li>
        </ul>
        <span class="view-badge recommended">Recommended</span>
      </a>

      <a href="dependency-graph.html" class="view-card">
        <div class="view-icon">🕸️</div>
        <div class="view-title">Graph View</div>
        <div class="view-description">
          Visualize dependencies as an interactive network graph with physics simulation.
        </div>
        <ul class="view-features">
          <li>Visual dependency graph</li>
          <li>Interactive navigation</li>
          <li>Auto-filtered for performance</li>
          <li>Best for exploring clusters</li>
        </ul>
        <span class="view-badge experimental">Large Dataset</span>
      </a>
    </div>

    <footer>
      Generated with Kairo • ${new Date().toLocaleString()}
    </footer>
  </div>
</body>
</html>`;
  }
}
