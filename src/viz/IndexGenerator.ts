import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import type { AnalysisResult } from '../types.js';

type DatasetInput = {
  id: string;
  name: string;
  source: string;
  result: AnalysisResult;
};

export class IndexGenerator {
  generate(datasets: DatasetInput[], outputPath: string): void {
    const dir = dirname(outputPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const html = this.generateHtml(datasets);
    writeFileSync(outputPath, html);
    console.log(`📄 Index page saved to: ${outputPath}`);
  }

  private generateHtml(datasets: DatasetInput[]): string {
    const totalComponents = datasets.reduce((s, d) => s + d.result.stats.totalComponents, 0);
    const totalDeps = datasets.reduce((s, d) => s + d.result.stats.totalDependencies, 0);
    const datasetList =
      datasets.length > 0
        ? datasets
            .map((d) => `${d.name} (${d.result.stats.totalComponents} components)`)
            .join(', ')
        : '';
    const graphDescription =
      datasets.length > 0
        ? `Interactive dependency graph. Use the <strong>Dataset</strong> dropdown in the header to switch between: ${datasetList}.`
        : 'Interactive dependency graph. Afegir datasets per començar.';
    const listDescription =
      datasets.length > 0
        ? `Browse all components as an interactive, searchable list with detailed dependency information. ${datasets.length > 1 ? 'Shows first dataset.' : ''}`
        : 'Browse components as a list. Afegir datasets per començar.';
    const datasetsJson = JSON.stringify(
      datasets.map((d) => ({
        id: d.id,
        name: d.name,
        source: d.source,
        components: d.result.stats.totalComponents,
        dependencies: d.result.stats.totalDependencies,
      }))
    );
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Kairo - Multi-dataset analysis</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .container { max-width: 1000px; width: 100%; }
    h1 { color: white; font-size: 48px; margin-bottom: 16px; text-align: center; }
    .subtitle { color: rgba(255,255,255,0.9); font-size: 18px; text-align: center; margin-bottom: 24px; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-bottom: 24px; }
    .stat-card { background: rgba(255,255,255,0.2); backdrop-filter: blur(10px); border-radius: 12px; padding: 20px; text-align: center; color: white; }
    .stat-value { font-size: 36px; font-weight: bold; margin-bottom: 8px; }
    .stat-label { font-size: 14px; opacity: 0.9; }
    .section-card { background: white; border-radius: 16px; padding: 24px; margin-bottom: 20px; box-shadow: 0 10px 40px rgba(0,0,0,0.2); }
    .section-title { font-size: 20px; font-weight: bold; margin-bottom: 16px; color: #333; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
    .views-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
    .view-card { background: white; border-radius: 16px; padding: 30px; box-shadow: 0 10px 40px rgba(0,0,0,0.2); text-decoration: none; color: inherit; display: block; transition: transform 0.2s, box-shadow 0.2s; }
    .view-card:hover { transform: translateY(-4px); box-shadow: 0 15px 50px rgba(0,0,0,0.3); }
    .view-icon { font-size: 48px; margin-bottom: 16px; }
    .view-title { font-size: 24px; font-weight: bold; margin-bottom: 12px; color: #333; }
    .view-description { font-size: 14px; color: #666; line-height: 1.6; }
    .dataset-list { font-size: 13px; color: #555; margin-top: 12px; }
    .datasets-list { list-style: none; }
    .dataset-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid #eee; }
    .dataset-item:last-child { border-bottom: none; }
    .dataset-info { flex: 1; min-width: 0; }
    .dataset-name { font-weight: 600; color: #333; font-size: 15px; }
    .dataset-source { font-size: 12px; color: #666; margin-top: 2px; word-break: break-all; }
    .dataset-stats { font-size: 12px; color: #888; margin-top: 2px; }
    .dataset-actions { display: flex; gap: 6px; flex-shrink: 0; }
    .btn { padding: 6px 12px; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; border: none; transition: background 0.2s; }
    .btn-sm { padding: 4px 10px; font-size: 12px; }
    .btn-primary { background: #667eea; color: white; }
    .btn-primary:hover { background: #5568d3; }
    .btn-secondary { background: #e5e7eb; color: #374151; }
    .btn-secondary:hover { background: #d1d5db; }
    .btn-danger { background: #fef2f2; color: #dc2626; }
    .btn-danger:hover { background: #fee2e2; }
    .add-dataset-form { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; margin-top: 16px; }
    .form-group { flex: 1; min-width: 120px; }
    .form-group label { display: block; font-size: 12px; font-weight: 600; color: #555; margin-bottom: 4px; }
    .form-group input { width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; }
    .form-group input:focus { outline: none; border-color: #667eea; }
    .empty-datasets { text-align: center; padding: 32px; color: #6b7280; font-size: 15px; }
    .refresh-hint { font-size: 12px; color: #6b7280; margin-top: 8px; }
    footer { text-align: center; color: rgba(255,255,255,0.8); margin-top: 24px; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Kairo</h1>
    <p class="subtitle">${datasets.length > 0 ? 'Switch between datasets in the graph view' : 'Afegir datasets per començar'}</p>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-value" id="stat-datasets">${datasets.length}</div><div class="stat-label">Datasets</div></div>
      <div class="stat-card"><div class="stat-value" id="stat-components">${totalComponents.toLocaleString()}</div><div class="stat-label">Total components</div></div>
      <div class="stat-card"><div class="stat-value" id="stat-deps">${totalDeps.toLocaleString()}</div><div class="stat-label">Total dependencies</div></div>
    </div>

    <div class="section-card">
      <div class="section-title">
        <span>Datasets</span>
        <button type="button" class="btn btn-primary btn-sm" id="btn-refresh">Refresh</button>
      </div>
      <div id="datasets-container">
        <ul class="datasets-list" id="datasets-list"></ul>
        <div class="empty-datasets" id="empty-datasets" style="display: none;">No hi ha datasets. Afegeix-ne un per començar.</div>
      </div>
      <div class="add-dataset-form">
        <div class="form-group" style="flex: 0 0 120px;">
          <label for="new-id">ID</label>
          <input type="text" id="new-id" placeholder="my-dataset">
        </div>
        <div class="form-group" style="flex: 1; min-width: 140px;">
          <label for="new-name">Nom</label>
          <input type="text" id="new-name" placeholder="My Dataset">
        </div>
        <div class="form-group" style="flex: 2; min-width: 200px;">
          <label for="new-source">Ruta</label>
          <input type="text" id="new-source" placeholder="./path/to/metadata">
        </div>
        <button type="button" class="btn btn-primary" id="btn-add">Crear</button>
      </div>
      <p class="refresh-hint">Per re-analitzar: <code>npm run analyze</code>. Per persistir canvis a config: actualitza <code>config/datasets.json</code>.</p>
    </div>

    <div class="views-grid">
      ${datasets.length > 0 ? `<a href="component-list.html" class="view-card">
        <div class="view-icon">📋</div>
        <div class="view-title">List view</div>
        <div class="view-description">
          ${listDescription}
        </div>
      </a>
      ` : ''}
      <a href="dependency-graph.html" class="view-card">
        <div class="view-icon">🕸️</div>
        <div class="view-title">Graph view</div>
        <div class="view-description">
          ${graphDescription}
        </div>
      </a>
    </div>
    <footer>Generated with Kairo • ${new Date().toLocaleString()}</footer>
  </div>

  <script>
    const STORAGE_KEY = 'kairo-datasets';
    const initialDatasets = ${datasetsJson};

    function loadDatasets() {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          return Array.isArray(parsed) ? parsed : initialDatasets;
        }
      } catch (e) {}
      return initialDatasets;
    }

    function saveDatasets(datasets) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(datasets));
      renderDatasets();
      updateStats();
    }

    function updateStats() {
      const datasets = loadDatasets();
      let totalComponents = 0;
      let totalDeps = 0;
      datasets.forEach(d => {
        totalComponents += d.components || 0;
        totalDeps += (d.dependencies !== undefined ? d.dependencies : 0);
      });
      const statEls = document.querySelectorAll('#stat-datasets, #stat-components, #stat-deps');
      if (statEls.length >= 3) {
        statEls[0].textContent = datasets.length;
        statEls[1].textContent = totalComponents.toLocaleString();
        statEls[2].textContent = totalDeps.toLocaleString();
      }
    }

    function renderDatasets() {
      const datasets = loadDatasets();
      const listEl = document.getElementById('datasets-list');
      const emptyEl = document.getElementById('empty-datasets');
      if (!listEl || !emptyEl) return;

      listEl.innerHTML = '';
      if (datasets.length === 0) {
        emptyEl.style.display = 'block';
        return;
      }
      emptyEl.style.display = 'none';

      datasets.forEach((d, i) => {
        const li = document.createElement('li');
        li.className = 'dataset-item';
        li.dataset.index = String(i);
        const isEditing = li.dataset.editing === 'true';
        li.innerHTML = \`
          <div class="dataset-info">
            <div class="dataset-name" data-field="name">\${escapeHtml(d.name)}</div>
            <div class="dataset-source" data-field="source">\${escapeHtml(d.source)}</div>
            <div class="dataset-stats">\${(d.components || 0).toLocaleString()} components\${d.dependencies !== undefined ? ', ' + d.dependencies.toLocaleString() + ' deps' : ''}</div>
          </div>
          <div class="dataset-actions">
            <button type="button" class="btn btn-secondary btn-sm" data-action="rename" title="Renombrar">✎</button>
            <button type="button" class="btn btn-danger btn-sm" data-action="delete" title="Eliminar">✕</button>
          </div>
        \`;
        listEl.appendChild(li);

        li.querySelector('[data-action="rename"]').addEventListener('click', () => renameDataset(i));
        li.querySelector('[data-action="delete"]').addEventListener('click', () => deleteDataset(i));
      });
    }

    function escapeHtml(s) {
      if (!s) return '';
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    function renameDataset(index) {
      const datasets = loadDatasets();
      const d = datasets[index];
      if (!d) return;
      const newName = prompt('Nou nom:', d.name);
      if (newName !== null && newName.trim() !== '') {
        datasets[index] = { ...d, name: newName.trim() };
        saveDatasets(datasets);
      }
    }

    function deleteDataset(index) {
      const datasets = loadDatasets();
      const d = datasets[index];
      if (!d || !confirm('Eliminar "' + d.name + '"?')) return;
      datasets.splice(index, 1);
      saveDatasets(datasets);
    }

    function addDataset() {
      const idEl = document.getElementById('new-id');
      const nameEl = document.getElementById('new-name');
      const sourceEl = document.getElementById('new-source');
      const id = (idEl && idEl.value || '').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-') || 'dataset';
      const name = (nameEl && nameEl.value || '').trim() || id;
      const source = (sourceEl && sourceEl.value || '').trim();
      if (!source) {
        alert('La ruta és obligatòria.');
        return;
      }
      const datasets = loadDatasets();
      if (datasets.some(d => d.id === id)) {
        alert('Ja existeix un dataset amb aquest ID.');
        return;
      }
      datasets.push({ id, name, source, components: 0 });
      saveDatasets(datasets);
      if (idEl) idEl.value = '';
      if (nameEl) nameEl.value = '';
      if (sourceEl) sourceEl.value = '';
    }

    function refreshDatasets() {
      window.location.reload();
    }

    document.getElementById('btn-add')?.addEventListener('click', addDataset);
    document.getElementById('btn-refresh')?.addEventListener('click', refreshDatasets);

    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored && initialDatasets.length > 0) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(initialDatasets));
    }

    renderDatasets();
    updateStats();
  </script>
</body>
</html>`;
  }
}
