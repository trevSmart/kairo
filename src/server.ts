#!/usr/bin/env node
import express from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, isAbsolute } from 'path';
import { MetadataAnalyzer } from './analyzer.js';
import { GraphVisualizer } from './viz/GraphVisualizer.js';
import { ListVisualizer } from './viz/ListVisualizer.js';
import { IndexGenerator, type DatasetEntry } from './viz/IndexGenerator.js';

const app = express();
app.use(express.json());

const CONFIG_PATH = join(process.cwd(), 'config', 'datasets.json');

type DatasetConfig = { id: string; name: string; source: string };

function loadDatasets(): DatasetConfig[] {
  if (!existsSync(CONFIG_PATH)) return [];
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  const config = JSON.parse(raw) as { datasets?: DatasetConfig[] };
  return config.datasets ?? [];
}

function saveDatasets(datasets: DatasetConfig[]): void {
  const dir = join(process.cwd(), 'config');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify({ datasets }, null, 2));
}

function resolveSourcePath(source: string): string {
  return isAbsolute(source) ? source : join(process.cwd(), source);
}

const analysisCache = new Map<string, { result: Awaited<ReturnType<MetadataAnalyzer['analyze']>>; at: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getOrAnalyze(datasetId: string): Promise<Awaited<ReturnType<MetadataAnalyzer['analyze']>> | null> {
  const datasets = loadDatasets();
  const ds = datasets.find(d => d.id === datasetId);
  if (!ds) return null;

  const cached = analysisCache.get(datasetId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.result;
  }

  const sourceDir = resolveSourcePath(ds.source);
  if (!existsSync(sourceDir)) return null;

  const analyzer = new MetadataAnalyzer();
  const result = await analyzer.analyze(sourceDir);
  analysisCache.set(datasetId, { result, at: Date.now() });
  return result;
}

const graphVisualizer = new GraphVisualizer();
const listVisualizer = new ListVisualizer();
const indexGenerator = new IndexGenerator();

// Homepage
app.get('/', (_req, res) => {
  const datasets = loadDatasets();
  const entries: DatasetEntry[] = datasets.map(d => ({ id: d.id, name: d.name, source: d.source }));
  const html = indexGenerator.generateAppHomeHtml(entries);
  res.type('html').send(html);
});

// API: list datasets
app.get('/api/datasets', (_req, res) => {
  res.json(loadDatasets());
});

// API: add dataset
app.post('/api/datasets', (req, res) => {
  const { id, name, source } = req.body;
  if (!id || !name || !source) {
    res.status(400).json({ error: 'id, name, and source are required' });
    return;
  }
  const datasets = loadDatasets();
  if (datasets.some(d => d.id === id)) {
    res.status(409).json({ error: 'Dataset ID already exists' });
    return;
  }
  datasets.push({ id: String(id).trim(), name: String(name).trim(), source: String(source).trim() });
  saveDatasets(datasets);
  analysisCache.delete(id);
  res.status(201).json({ id, name, source });
});

// API: remove dataset
app.delete('/api/datasets/:id', (req, res) => {
  const { id } = req.params;
  const original = loadDatasets();
  const datasets = original.filter(d => d.id !== id);
  if (datasets.length === original.length) {
    res.status(404).json({ error: 'Dataset not found' });
    return;
  }
  saveDatasets(datasets);
  analysisCache.delete(id);
  res.status(204).send();
});

// List view - on-demand analysis
app.get('/list/:datasetId', async (req, res) => {
  const { datasetId } = req.params;
  const datasets = loadDatasets();
  const ds = datasets.find(d => d.id === datasetId);
  if (!ds) {
    res.status(404).send('Dataset not found');
    return;
  }

  const result = await getOrAnalyze(datasetId);
  if (!result) {
    res.status(500).send('Analysis failed. Check that the source path exists and contains valid metadata.');
    return;
  }

  const html = listVisualizer.generateToHtml(result, {
    datasetName: ds.name,
    backHref: '/',
  });
  res.type('html').send(html);
});

// Graph view - on-demand analysis
app.get('/graph/:datasetId', async (req, res) => {
  const { datasetId } = req.params;
  const datasets = loadDatasets();
  const ds = datasets.find(d => d.id === datasetId);
  if (!ds) {
    res.status(404).send('Dataset not found');
    return;
  }

  const result = await getOrAnalyze(datasetId);
  if (!result) {
    res.status(500).send('Analysis failed. Check that the source path exists and contains valid metadata.');
    return;
  }

  const html = graphVisualizer.generateToHtml(result, {
    datasetName: ds.name,
    backHref: '/',
  });
  res.type('html').send(html);
});

const PORT = Number(process.env.PORT) || 3456;
app.listen(PORT, () => {
  console.log(`🚀 Kairo app running at http://localhost:${PORT}`);
  console.log('   Add datasets on the homepage, then open list or graph view to analyze on demand.');
});
