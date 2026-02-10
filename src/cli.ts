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
  .option('-s, --source <path>', 'Source directory containing Salesforce metadata', './test-data')
  .option('-o, --output <path>', 'Output directory for results', './output')
  .option('-d, --datasets', 'Use config/datasets.json and generate one graph with a dataset toggle')
  .action(async (options) => {
    const outputDir = join(process.cwd(), options.output);

    console.log('🚀 Kairo Metadata Analyzer');
    console.log('==========================\n');

    const analyzer = new MetadataAnalyzer();
    const graphVisualizer = new HtmlVisualizer();
    const simpleVisualizer = new SimpleHtmlVisualizer();
    const indexGenerator = new IndexGenerator();

    if (options.datasets) {
      const configPath = join(process.cwd(), 'config', 'datasets.json');
      if (!existsSync(configPath)) {
        console.error('❌ config/datasets.json not found. Create it or run without --datasets.');
        process.exit(1);
      }
      const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
        datasets: Array<{ id: string; name: string; source: string }>;
      };
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
      if (datasets.length === 0) {
        console.error('❌ No dataset could be analyzed.');
        process.exit(1);
      }
      const graphPath = join(outputDir, 'dependency-graph.html');
      graphVisualizer.generateMultiDataset(datasets, graphPath);
      const indexPath = join(outputDir, 'index.html');
      indexGenerator.generateMulti(datasets.map(d => d.result), datasets.map(d => d.name), indexPath);
      console.log('\n✨ Multi-dataset analysis complete!');
      console.log(`   🏠 Index: ${indexPath}`);
      console.log(`   🕸️  Graph (toggle datasets): ${graphPath}`);
      return;
    }

    const sourceDir = isAbsolute(options.source) ? options.source : join(process.cwd(), options.source);
    const result = await analyzer.analyze(sourceDir);

    console.log('\n📈 Analysis Results:');
    console.log(`  - Total components: ${result.stats.totalComponents}`);
    console.log(`  - Total dependencies: ${result.stats.totalDependencies}`);
    console.log('\n  Components by type:');
    Object.entries(result.stats.componentsByType).forEach(([type, count]) => {
      console.log(`    - ${type}: ${count}`);
    });

    const graphPath = join(outputDir, 'dependency-graph.html');
    graphVisualizer.generate(result, graphPath);

    const simplePath = join(outputDir, 'component-list.html');
    simpleVisualizer.generate(result, simplePath);

    const indexPath = join(outputDir, 'index.html');
    indexGenerator.generate(result, indexPath);

    console.log('\n✨ Analysis complete!');
    console.log(`   🏠 Index: ${indexPath}`);
    console.log(`   📋 List view: ${simplePath}`);
    console.log(`   🕸️  Graph view: ${graphPath}`);
  });

program.parse();
