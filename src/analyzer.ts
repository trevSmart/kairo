import { readFileSync } from 'fs';
import { MetadataScanner } from './parsers/MetadataScanner.js';
import { CustomObjectParser } from './parsers/CustomObjectParser.js';
import { ApexParser } from './parsers/ApexParser.js';
import { LWCParser } from './parsers/LWCParser.js';
import { AuraParser } from './parsers/AuraParser.js';
import { GraphBuilder } from './graph/GraphBuilder.js';
import type { AnalysisResult, MetadataType } from './types.js';

export class MetadataAnalyzer {
  private scanner = new MetadataScanner();
  private objectParser = new CustomObjectParser();
  private apexParser = new ApexParser();
  private lwcParser = new LWCParser();
  private auraParser = new AuraParser();
  private objectNameMap = new Map<string, string>();

  private isTestClass(filePath: string): boolean {
    try {
      const content = readFileSync(filePath, 'utf-8');
      return /@\s*[Ii]sTest\b/.test(content);
    } catch {
      return false;
    }
  }

  async analyze(sourceDir: string): Promise<AnalysisResult> {
    console.log(`🔍 Scanning metadata in: ${sourceDir}`);

    const files = this.scanner.scan(sourceDir);
    console.log(`📦 Found ${files.length} metadata files`);

    const graphBuilder = new GraphBuilder();
    let processed = 0;

    const resolveObjectName = (name: string): string => {
      const key = name.toLowerCase();
      const existing = this.objectNameMap.get(key);
      if (existing) return existing;
      this.objectNameMap.set(key, name);
      return name;
    };

    for (const file of files) {
      try {
        if (file.type === 'CustomObject') {
          const { component, dependencies } = this.objectParser.parse(file.path);
          this.objectNameMap.set(component.name.toLowerCase(), component.name);
          graphBuilder.addComponent(component);
          dependencies.forEach(dep => graphBuilder.addDependency(dep));
        } else if (file.type === 'ApexClass') {
          if (this.isTestClass(file.path)) continue;
          const { component, dependencies } = this.apexParser.parse(file.path, 'ApexClass', resolveObjectName);
          graphBuilder.addComponent(component);
          dependencies.forEach(dep => graphBuilder.addDependency(dep));
        } else if (file.type === 'ApexTrigger') {
          const { component, dependencies } = this.apexParser.parse(file.path, 'ApexTrigger', resolveObjectName);
          graphBuilder.addComponent(component);
          dependencies.forEach(dep => graphBuilder.addDependency(dep));
        } else if (file.type === 'LWC') {
          const parts = file.path.split('/');
          const componentName = parts[parts.length - 2];
          const componentId = `LightningWebComponent:${componentName}`;
          graphBuilder.addComponent({
            id: componentId,
            name: componentName,
            type: 'LightningWebComponent',
            filePath: file.path,
          });
          const lwcDeps = this.lwcParser.parse(file.path, componentId);
          lwcDeps.forEach(dep => graphBuilder.addDependency(dep));
        } else if (file.type === 'Aura') {
          const fileName = file.path.split('/').pop()!;
          const componentName = fileName.replace(/\.(cmp|app)$/, '');
          const componentId = `AuraComponent:${componentName}`;
          graphBuilder.addComponent({
            id: componentId,
            name: componentName,
            type: 'AuraComponent',
            filePath: file.path,
          });
          const auraDeps = this.auraParser.parse(file.path, componentId);
          auraDeps.forEach(dep => graphBuilder.addDependency(dep));
        }

        processed++;
        if (processed % 100 === 0) {
          console.log(`  ⚙️  Processed ${processed}/${files.length} files...`);
        }
      } catch (error) {
        console.warn(`  ⚠️  Failed to parse ${file.path}: ${error}`);
      }
    }

    console.log(`✅ Processed ${processed} metadata components`);

    const graph = graphBuilder.build();

    // Calculate stats
    const componentsByType: Record<string, number> = {};
    graph.components.forEach(comp => {
      componentsByType[comp.type] = (componentsByType[comp.type] || 0) + 1;
    });

    return {
      graph,
      stats: {
        totalComponents: graph.components.size,
        componentsByType: componentsByType as Record<MetadataType, number>,
        totalDependencies: graph.dependencies.length,
      },
    };
  }
}
