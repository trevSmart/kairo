import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, isAbsolute, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MetadataAnalyzer } from './analyzer.js';
import { HtmlVisualizer } from './viz/HtmlVisualizer.js';
import { SimpleHtmlVisualizer } from './viz/SimpleHtmlVisualizer.js';
import { IndexGenerator } from './viz/IndexGenerator.js';
import { DependencyWeightCalculator } from './utils/DependencyWeightCalculator.js';
import type { AnalysisResult, Dependency } from './types.js';

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

export async function createApp(): Promise<void> {
  const analyzer = new MetadataAnalyzer();
  const simpleViz = new SimpleHtmlVisualizer();
  const indexGenerator = new IndexGenerator();

  const configPath = join(PROJECT_ROOT, 'config/datasets.json');
  let datasets: Array<{ id: string; name: string; source: string }> = [];
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as { datasets: Array<{ id: string; name: string; source: string }> };
    datasets = config.datasets || [];
  }

  const server = createServer(async (req, res) => {
    const url = req.url || '/';
    const method = req.method || 'GET';

    if (method === 'GET' && url === '/api/datasets') {
      return sendJson(res, { datasets });
    }

    if (method === 'POST' && url === '/api/analyze') {
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

    if (method === 'POST' && url === '/api/list-data') {
      try {
        const body = (await parseJsonBody(req)) as { source?: string; id?: string; name?: string };
        const source = body?.source;
        if (!source || typeof source !== 'string') {
          return sendJson(res, { error: 'Missing or invalid source' }, 400);
        }
        const sourceDir = resolveSource(source);
        const result = await analyzer.analyze(sourceDir);
        const listData = getListData(result);
        return sendJson(res, listData);
      } catch (err) {
        console.error('List data error:', err);
        return sendJson(res, { error: String(err) }, 500);
      }
    }

    if (method === 'POST' && url === '/api/graph-data') {
      try {
        const body = (await parseJsonBody(req)) as { source?: string; id?: string; name?: string };
        const source = body?.source;
        if (!source || typeof source !== 'string') {
          return sendJson(res, { error: 'Missing or invalid source' }, 400);
        }
        const sourceDir = resolveSource(source);
        const result = await analyzer.analyze(sourceDir);
        const id = body.id || 'dataset';
        const name = body.name || id;
        const graphData = getGraphData(result, id, name);
        return sendJson(res, graphData);
      } catch (err) {
        console.error('Graph data error:', err);
        return sendJson(res, { error: String(err) }, 500);
      }
    }

    if (method === 'GET' && (url === '/' || url === '/index.html')) {
      const datasetsForIndex = datasets.map(d => ({
        id: d.id,
        name: d.name,
        source: d.source,
        components: 0,
        dependencies: 0,
      }));
      const html = indexGenerator.generateHtml(datasetsForIndex);
      return sendHtml(res, html);
    }

    if (method === 'GET' && url === '/list.html') {
      const listHtml = simpleViz.generateShell ? simpleViz.generateShell() : getListShell();
      return sendHtml(res, listHtml);
    }

    if (method === 'GET' && url === '/graph.html') {
      const graphHtml = getGraphShell();
      return sendHtml(res, graphHtml);
    }

    const filePath = join(OUTPUT_DIR, url === '/' ? 'index.html' : url.replace(/^\//, ''));
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

  const port = 3456;
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
