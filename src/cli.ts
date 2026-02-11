#!/usr/bin/env node
import { readFileSync, existsSync } from 'fs';
import { Command } from 'commander';
import { MetadataAnalyzer } from './analyzer.js';
import { HtmlVisualizer } from './viz/HtmlVisualizer.js';
import { SimpleHtmlVisualizer } from './viz/SimpleHtmlVisualizer.js';
import { IndexGenerator } from './viz/IndexGenerator.js';
import { join, isAbsolute } from 'path';

const program = new Command();

program
  .name('kairo')
  .description('Salesforce org metadata analyzer - extracts business processes from technical metadata')
  .version('0.1.0');

program
  .command('analyze')
  .description('Analyze Salesforce metadata and generate dependency graph')
  .option('-o, --output <path>', 'Output directory for results', './output')
  .option('-c, --config <path>', 'Path to datasets config', 'config/datasets.json')
  .action(async (options) => {
    const outputDir = join(process.cwd(), options.output);
    const configPath = join(process.cwd(), options.config);

    console.log('🚀 Kairo Metadata Analyzer');
    console.log('==========================\n');

    const analyzer = new MetadataAnalyzer();
    const graphVisualizer = new HtmlVisualizer();
    const simpleVisualizer = new SimpleHtmlVisualizer();
    const indexGenerator = new IndexGenerator();

    let config: { datasets: Array<{ id: string; name: string; source: string }> };
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
        datasets: Array<{ id: string; name: string; source: string }>;
      };
    } else {
      console.log('⚠️  Config not found, using empty datasets.');
      config = { datasets: [] };
    }

    const datasets: Array<{ id: string; name: string; result: Awaited<ReturnType<MetadataAnalyzer['analyze']>> }> = [];
    for (const ds of config.datasets) {
      const sourceDir = isAbsolute(ds.source) ? ds.source : join(process.cwd(), ds.source);
      console.log(`📂 Analyzing: ${ds.name} (${ds.source})`);
      try {
        const result = await analyzer.analyze(sourceDir);
        datasets.push({ id: ds.id, name: ds.name, result });
        console.log(`   ✅ ${result.stats.totalComponents} components, ${result.stats.totalDependencies} dependencies`);
      } catch (err) {
        console.warn(`   ⚠️  Failed: ${err}`);
      }
    }

    const graphPath = join(outputDir, 'dependency-graph.html');
    graphVisualizer.generate(datasets, graphPath);

    if (datasets.length > 0) {
      const listPath = join(outputDir, 'component-list.html');
      simpleVisualizer.generate(datasets[0].result, listPath);
    }

    const indexPath = join(outputDir, 'index.html');
    const datasetsWithSource = datasets.map((d) => ({
      id: d.id,
      name: d.name,
      source: config.datasets.find((c) => c.id === d.id)?.source ?? '',
      result: d.result,
    }));
    indexGenerator.generate(datasetsWithSource, indexPath);

    console.log('\n✨ Analysis complete!');
    console.log(`   🏠 Index: ${indexPath}`);
    console.log(`   📋 List view: ${datasets.length > 0 ? join(outputDir, 'component-list.html') : '(no datasets)'}`);
    console.log(`   🕸️  Graph: ${graphPath}`);
  });

program.parse();
