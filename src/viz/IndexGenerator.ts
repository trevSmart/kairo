import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import type { AnalysisResult } from '../types.js';

export type ProjectInput = {
  id: string;
  name: string;
  source: string;
  result?: AnalysisResult;
  components?: number;
  dependencies?: number;
};

export class IndexGenerator {
  generate(projects: ProjectInput[], outputPath: string): void {
    const dir = dirname(outputPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const html = this.generateHtml(projects);
    writeFileSync(outputPath, html);
    console.log(`📄 Index page saved to: ${outputPath}`);
  }

  generateHtml(projects: ProjectInput[]): string {
    const getComponents = (p: ProjectInput) => p.result?.stats.totalComponents ?? p.components ?? 0;
    const getDeps = (p: ProjectInput) => p.result?.stats.totalDependencies ?? p.dependencies ?? 0;
    const totalComponents = projects.reduce((s, p) => s + getComponents(p), 0);
    const totalDeps = projects.reduce((s, p) => s + getDeps(p), 0);
    const projectList =
      projects.length > 0
        ? projects
            .map((p) => `${p.name} (${getComponents(p)} components)`)
            .join(', ')
        : '';
    const graphDescription =
      projects.length > 0
        ? `Interactive dependency graph. Use the <strong>Project</strong> dropdown in the header to switch between: ${projectList}.`
        : 'Interactive dependency graph. Afegir projectes Salesforce per començar.';
    const listDescription =
      projects.length > 0
        ? `Browse all components as an interactive, searchable list with detailed dependency information. ${projects.length > 1 ? 'Shows first project.' : ''}`
        : 'Browse components as a list. Afegir projectes Salesforce per començar.';
    const projectsJson = JSON.stringify(
      projects.map((p) => ({
        id: p.id,
        name: p.name,
        source: p.source,
        components: getComponents(p),
        dependencies: getDeps(p),
      }))
    );
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Kairo - Salesforce Projects</title>
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
    .project-list { font-size: 13px; color: #555; margin-top: 12px; }
    .projects-list { list-style: none; }
    .project-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid #eee; }
    .project-item:last-child { border-bottom: none; }
    .project-info { flex: 1; min-width: 0; }
    .project-name { font-weight: 600; color: #333; font-size: 15px; }
    .project-source { font-size: 12px; color: #666; margin-top: 2px; word-break: break-all; }
    .project-stats { font-size: 12px; color: #888; margin-top: 2px; }
    .project-actions { display: flex; gap: 6px; flex-shrink: 0; }
    .btn { padding: 6px 12px; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; border: none; transition: background 0.2s; }
    .btn-sm { padding: 4px 10px; font-size: 12px; }
    .btn-primary { background: #667eea; color: white; }
    .btn-primary:hover { background: #5568d3; }
    .btn-secondary { background: #e5e7eb; color: #374151; }
    .btn-secondary:hover { background: #d1d5db; }
    .btn-danger { background: #fef2f2; color: #dc2626; }
    .btn-danger:hover { background: #fee2e2; }
    .add-project-form { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; margin-top: 16px; }
    .form-group { flex: 1; min-width: 120px; }
    .form-group label { display: block; font-size: 12px; font-weight: 600; color: #555; margin-bottom: 4px; }
    .form-group input { width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; }
    .form-group input:focus { outline: none; border-color: #667eea; }
    .empty-projects { text-align: center; padding: 32px; color: #6b7280; font-size: 15px; }
    .refresh-hint { font-size: 12px; color: #6b7280; margin-top: 8px; }
    footer { text-align: center; color: rgba(255,255,255,0.8); margin-top: 24px; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Kairo</h1>
    <p class="subtitle">${projects.length > 0 ? 'Canvia entre projectes Salesforce al graph view' : 'Afegir projectes Salesforce per començar'}</p>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-value" id="stat-projects">${projects.length}</div><div class="stat-label">Projectes</div></div>
      <div class="stat-card"><div class="stat-value" id="stat-components">${totalComponents.toLocaleString()}</div><div class="stat-label">Total components</div></div>
      <div class="stat-card"><div class="stat-value" id="stat-deps">${totalDeps.toLocaleString()}</div><div class="stat-label">Total dependencies</div></div>
    </div>

    <div class="section-card">
      <div class="section-title">
        <span>Projectes Salesforce</span>
        <button type="button" class="btn btn-primary btn-sm" id="btn-refresh">Refresh</button>
      </div>
      <div id="projects-container">
        <ul class="projects-list" id="projects-list"></ul>
        <div class="empty-projects" id="empty-projects" style="display: none;">No hi ha projectes. Afegeix-ne un per començar.</div>
      </div>
      <div class="add-project-form">
        <div class="form-group" style="flex: 0 0 120px;">
          <label for="new-id">ID</label>
          <input type="text" id="new-id" placeholder="my-project">
        </div>
        <div class="form-group" style="flex: 1; min-width: 140px;">
          <label for="new-name">Nom</label>
          <input type="text" id="new-name" placeholder="My Salesforce Project">
        </div>
        <div class="form-group" style="flex: 2; min-width: 200px;">
          <label for="new-source">Ruta</label>
          <input type="text" id="new-source" placeholder="./path/to/metadata">
        </div>
        <button type="button" class="btn btn-primary" id="btn-add">Crear</button>
      </div>
      <p class="refresh-hint">L'anàlisi es genera quan obres la list view o graph view d'un projecte. Per persistir canvis: actualitza <code>config/projects.json</code>.</p>
    </div>

    <div class="views-grid">
      ${projects.length > 0 ? `<a href="list.html" class="view-card">
        <div class="view-icon">📋</div>
        <div class="view-title">List view</div>
        <div class="view-description">
          ${listDescription}
        </div>
      </a>
      ` : ''}
      <a href="graph.html" class="view-card">
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
    const STORAGE_KEY = 'kairo-projects';
    const initialProjects = ${projectsJson};

    function loadProjects() {
      try {
        let stored = localStorage.getItem(STORAGE_KEY);
        if (!stored) {
          const legacy = localStorage.getItem('kairo-datasets');
          if (legacy) {
            localStorage.setItem(STORAGE_KEY, legacy);
            localStorage.removeItem('kairo-datasets');
            stored = legacy;
          }
        }
        if (stored) {
          const parsed = JSON.parse(stored);
          return Array.isArray(parsed) ? parsed : initialProjects;
        }
      } catch (e) {}
      return initialProjects;
    }

    function saveProjects(projects) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
      renderProjects();
      updateStats();
    }

    function updateStats() {
      const projects = loadProjects();
      let totalComponents = 0;
      let totalDeps = 0;
      projects.forEach(p => {
        totalComponents += p.components || 0;
        totalDeps += (p.dependencies !== undefined ? p.dependencies : 0);
      });
      const statEls = document.querySelectorAll('#stat-projects, #stat-components, #stat-deps');
      if (statEls.length >= 3) {
        statEls[0].textContent = projects.length;
        statEls[1].textContent = totalComponents.toLocaleString();
        statEls[2].textContent = totalDeps.toLocaleString();
      }
    }

    function renderProjects() {
      const projects = loadProjects();
      const listEl = document.getElementById('projects-list');
      const emptyEl = document.getElementById('empty-projects');
      if (!listEl || !emptyEl) return;

      listEl.innerHTML = '';
      if (projects.length === 0) {
        emptyEl.style.display = 'block';
        return;
      }
      emptyEl.style.display = 'none';

      projects.forEach((p, i) => {
        const li = document.createElement('li');
        li.className = 'project-item';
        li.dataset.index = String(i);
        const isEditing = li.dataset.editing === 'true';
        li.innerHTML = \`
          <div class="project-info">
            <div class="project-name" data-field="name">\${escapeHtml(p.name)}</div>
            <div class="project-source" data-field="source">\${escapeHtml(p.source)}</div>
            <div class="project-stats">\${(p.components || 0).toLocaleString()} components\${p.dependencies !== undefined ? ', ' + p.dependencies.toLocaleString() + ' deps' : ''}</div>
          </div>
          <div class="project-actions">
            <a href="list.html?project=\${encodeURIComponent(p.id)}" class="btn btn-primary btn-sm" title="List view">📋</a>
            <a href="graph.html?project=\${encodeURIComponent(p.id)}" class="btn btn-primary btn-sm" title="Graph view">🕸️</a>
            <button type="button" class="btn btn-secondary btn-sm" data-action="rename" title="Renombrar">✎</button>
            <button type="button" class="btn btn-danger btn-sm" data-action="delete" title="Eliminar">✕</button>
          </div>
        \`;
        listEl.appendChild(li);

        li.querySelector('[data-action="rename"]').addEventListener('click', () => renameProject(i));
        li.querySelector('[data-action="delete"]').addEventListener('click', () => deleteProject(i));
      });
    }

    function escapeHtml(s) {
      if (!s) return '';
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    function renameProject(index) {
      const projects = loadProjects();
      const p = projects[index];
      if (!p) return;
      const newName = prompt('Nou nom:', p.name);
      if (newName !== null && newName.trim() !== '') {
        projects[index] = { ...p, name: newName.trim() };
        saveProjects(projects);
      }
    }

    function deleteProject(index) {
      const projects = loadProjects();
      const p = projects[index];
      if (!p || !confirm('Eliminar "' + p.name + '"?')) return;
      projects.splice(index, 1);
      saveProjects(projects);
    }

    function addProject() {
      const idEl = document.getElementById('new-id');
      const nameEl = document.getElementById('new-name');
      const sourceEl = document.getElementById('new-source');
      const id = (idEl && idEl.value || '').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-') || 'project';
      const name = (nameEl && nameEl.value || '').trim() || id;
      const source = (sourceEl && sourceEl.value || '').trim();
      if (!source) {
        alert('La ruta és obligatòria.');
        return;
      }
      const projects = loadProjects();
      if (projects.some(p => p.id === id)) {
        alert('Ja existeix un projecte amb aquest ID.');
        return;
      }
      projects.push({ id, name, source, components: 0 });
      saveProjects(projects);
      if (idEl) idEl.value = '';
      if (nameEl) nameEl.value = '';
      if (sourceEl) sourceEl.value = '';
    }

    function refreshProjects() {
      window.location.reload();
    }

    document.getElementById('btn-add')?.addEventListener('click', addProject);
    document.getElementById('btn-refresh')?.addEventListener('click', refreshProjects);

    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored && initialProjects.length > 0) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(initialProjects));
    }

    renderProjects();
    updateStats();
  </script>
</body>
</html>`;
  }
}
