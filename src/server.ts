import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, isAbsolute, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MetadataAnalyzer } from './analyzer.js';
import { HtmlVisualizer } from './viz/HtmlVisualizer.js';
import { IndexGenerator } from './viz/IndexGenerator.js';
import { DependencyWeightCalculator } from './utils/DependencyWeightCalculator.js';
import type { AnalysisResult } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const OUTPUT_DIR = join(PROJECT_ROOT, 'output');

function resolveSource(source: string): string {
  return isAbsolute(source) ? source : join(PROJECT_ROOT, source);
}

function serializeAnalysisResult(result: AnalysisResult): object {
  return {
    graph: {
      components: Array.from(result.graph.components.values()),
      dependencies: result.graph.dependencies,
    },
    stats: result.stats,
  };
}

type ListComponent = {
  id: string;
  name: string;
  type: string;
  label?: string;
  connections: number;
  incoming: Array<{ id: string; weight: number }>;
  outgoing: Array<{ id: string; weight: number }>;
};

function getListData(result: AnalysisResult): { components: ListComponent[]; stats: AnalysisResult['stats'] } {
  const connectionCounts = new Map<string, number>();
  const incomingConnections = new Map<string, Array<{ id: string; weight: number }>>();
  const outgoingConnections = new Map<string, Array<{ id: string; weight: number }>>();

  result.graph.dependencies.forEach(dep => {
    const weight = dep.weight ?? DependencyWeightCalculator.calculate(dep);
    connectionCounts.set(dep.from, (connectionCounts.get(dep.from) || 0) + 1);
    connectionCounts.set(dep.to, (connectionCounts.get(dep.to) || 0) + 1);
    if (!outgoingConnections.has(dep.from)) outgoingConnections.set(dep.from, []);
    outgoingConnections.get(dep.from)!.push({ id: dep.to, weight });
    if (!incomingConnections.has(dep.to)) incomingConnections.set(dep.to, []);
    incomingConnections.get(dep.to)!.push({ id: dep.from, weight });
  });

  const components: ListComponent[] = Array.from(result.graph.components.values())
    .map(comp => ({
      ...comp,
      connections: connectionCounts.get(comp.id) || 0,
      incoming: incomingConnections.get(comp.id) || [],
      outgoing: outgoingConnections.get(comp.id) || [],
    }))
    .sort((a, b) => b.connections - a.connections);

  return { components, stats: result.stats };
}

function getGraphData(
  result: AnalysisResult,
  id: string,
  name: string
): { id: string; name: string; stats: object; nodes: object[]; visNodes: object[]; visEdges: object[]; recommended: object } {
  const viz = new HtmlVisualizer();
  return viz.buildGraphPayload(result, id, name) as ReturnType<typeof getGraphData>;
}

async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendHtml(res: ServerResponse, html: string, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function createNdjsonStream<T>(
  res: ServerResponse,
  onAnalyze: (onProgress: (processed: number, total: number) => void) => Promise<AnalysisResult>,
  transform: (result: AnalysisResult) => T
): void {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Transfer-Encoding': 'chunked',
  });
  const writeLine = (obj: object) => res.write(JSON.stringify(obj) + '\n');
  const onProgress = (processed: number, total: number) => {
    writeLine({ progress: { processed, total } });
    return new Promise<void>(r => setImmediate(r));
  };

  onAnalyze(onProgress)
    .then(analysisResult => {
      writeLine({ result: transform(analysisResult) });
      res.end();
    })
    .catch(err => {
      console.error('Stream analyze error:', err);
      writeLine({ error: String(err) });
      res.end();
    });
}

export async function createApp(): Promise<void> {
  const analyzer = new MetadataAnalyzer();
  const graphViz = new HtmlVisualizer();
  const indexGenerator = new IndexGenerator();

  const projectsPath = join(PROJECT_ROOT, 'config/projects.json');
  const datasetsPath = join(PROJECT_ROOT, 'config/datasets.json');
  let projects: Array<{ id: string; name: string; source: string }> = [];
  const configPath = existsSync(projectsPath) ? projectsPath : datasetsPath;
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      projects?: Array<{ id: string; name: string; source: string }>;
      datasets?: Array<{ id: string; name: string; source: string }>;
    };
    projects = config.projects ?? config.datasets ?? [];
  }

  function findProject(id: string): { id: string; name: string; source: string } | undefined {
    return projects.find(p => p.id === id);
  }

  const server = createServer(async (req, res) => {
    const url = req.url || '/';
    const method = req.method || 'GET';
    const urlObj = new URL(url, 'http://localhost');

    if (method === 'GET' && (urlObj.pathname === '/api/datasets' || urlObj.pathname === '/api/projects')) {
      return sendJson(res, { projects });
    }

    if (method === 'POST' && urlObj.pathname === '/api/analyze') {
      try {
        const body = (await parseJsonBody(req)) as { source?: string };
        const source = body?.source;
        if (!source || typeof source !== 'string') {
          return sendJson(res, { error: 'Missing or invalid source' }, 400);
        }
        const sourceDir = resolveSource(source);
        const result = await analyzer.analyze(sourceDir);
        return sendJson(res, serializeAnalysisResult(result));
      } catch (err) {
        console.error('Analyze error:', err);
        return sendJson(res, { error: String(err) }, 500);
      }
    }

    if (method === 'POST' && urlObj.pathname === '/api/list-data') {
      try {
        const body = (await parseJsonBody(req)) as { source?: string; id?: string; name?: string };
        const source = body?.source;
        if (!source || typeof source !== 'string') {
          return sendJson(res, { error: 'Missing or invalid source' }, 400);
        }
        const sourceDir = resolveSource(source);
        createNdjsonStream(res, onProgress => analyzer.analyze(sourceDir, onProgress), getListData);
        return;
      } catch (err) {
        console.error('List data error:', err);
        return sendJson(res, { error: String(err) }, 500);
      }
    }

    if (method === 'POST' && urlObj.pathname === '/api/graph-data') {
      try {
        const body = (await parseJsonBody(req)) as { source?: string; id?: string; name?: string };
        const source = body?.source;
        if (!source || typeof source !== 'string') {
          return sendJson(res, { error: 'Missing or invalid source' }, 400);
        }
        const sourceDir = resolveSource(source);
        const result = await analyzer.analyze(sourceDir);
        const id = body.id || 'project';
        const name = body.name || id;
        const graphData = getGraphData(result, id, name);
        return sendJson(res, graphData);
      } catch (err) {
        console.error('Graph data error:', err);
        return sendJson(res, { error: String(err) }, 500);
      }
    }

    if (method === 'GET' && (urlObj.pathname === '/' || urlObj.pathname === '/index.html')) {
      const projectsForIndex = projects.map(p => ({
        id: p.id,
        name: p.name,
        source: p.source,
        components: 0,
        dependencies: 0,
      }));
      const html = indexGenerator.generateHtml(projectsForIndex);
      return sendHtml(res, html);
    }

    if (method === 'GET' && urlObj.pathname === '/list.html') {
      return sendHtml(res, getListShell());
    }

    if (method === 'GET' && urlObj.pathname === '/graph.html') {
      return sendHtml(res, getGraphShell());
    }

    if (method === 'POST' && urlObj.pathname === '/api/render-graph') {
      try {
        const body = (await parseJsonBody(req)) as { source?: string; id?: string; name?: string };
        const source = body?.source;
        if (!source || typeof source !== 'string') {
          return sendHtml(res, '<!DOCTYPE html><html><body><h1>Error</h1><p>Missing source</p></body></html>', 400);
        }
        const sourceDir = resolveSource(source);
        const id = body.id || 'project';
        const name = body.name || id;
        createNdjsonStream(
          res,
          onProgress => analyzer.analyze(sourceDir, onProgress),
          result => ({ html: graphViz.generateHtmlForProject(result, id, name) })
        );
        return;
      } catch (err) {
        console.error('Graph render error:', err);
        return sendHtml(res, '<!DOCTYPE html><html><body><h1>Error</h1><p>' + String(err) + '</p></body></html>', 500);
      }
    }

    const pathname = urlObj.pathname;
    const filePath = join(OUTPUT_DIR, pathname === '/' ? 'index.html' : pathname.replace(/^\//, '').split('?')[0]);
    if (existsSync(filePath) && !filePath.includes('..')) {
      const content = readFileSync(filePath, 'utf-8');
      const contentType = filePath.endsWith('.html') ? 'text/html' : filePath.endsWith('.css') ? 'text/css' : 'application/javascript';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  const port = Number(process.env.PORT) || 3456;
  server.listen(port, () => {
    console.log(`🚀 Kairo server running at http://localhost:${port}`);
    console.log(`   Homepage: http://localhost:${port}/`);
    console.log(`   List view: http://localhost:${port}/list.html`);
    console.log(`   Graph view: http://localhost:${port}/graph.html`);
  });
}

function getListShell(): string {
  return readFileSync(join(__dirname, 'viz', 'list-shell.html'), 'utf-8');
}

function getGraphShell(): string {
  return readFileSync(join(__dirname, 'viz', 'graph-shell.html'), 'utf-8');
}
