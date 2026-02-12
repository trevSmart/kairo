import { readFileSync } from 'fs';
import { MetadataScanner } from './parsers/MetadataScanner.js';
import { CustomObjectParser } from './parsers/CustomObjectParser.js';
import { ApexParser } from './parsers/ApexParser.js';
import { LWCParser } from './parsers/LWCParser.js';
import { AuraParser } from './parsers/AuraParser.js';
import { GraphBuilder } from './graph/GraphBuilder.js';
import type { AnalysisResult, MetadataType } from './types.js';
import type { MetadataIndexes } from './parsers/MetadataScanner.js';

const STANDARD_OBJECTS = ['Account', 'Contact', 'Opportunity', 'Case', 'Lead'];

export class MetadataAnalyzer {
  private scanner = new MetadataScanner();
  private objectParser = new CustomObjectParser();
  private apexParser = new ApexParser();
  private lwcParser = new LWCParser();
  private auraParser = new AuraParser();

  private isTestClass(filePath: string): boolean {
    try {
      const content = readFileSync(filePath, 'utf-8');
      return /@\s*[Ii]sTest\b/.test(content);
    } catch {
      return false;
    }
  }

  async analyze(
    sourceDir: string,
    onProgress?: (processed: number, total: number) => void | Promise<void>
  ): Promise<AnalysisResult> {
    console.log(`🔍 Scanning metadata in: ${sourceDir}`);

    const { files, indexes } = this.scanner.scanWithIndexes(sourceDir);
    const objectNameMap = this.buildObjectNameMap(indexes);
    console.log(`📦 Found ${files.length} metadata files`);

    const graphBuilder = new GraphBuilder();
    let processed = 0;
    await (onProgress?.(0, files.length) ?? Promise.resolve());

    const resolveObjectName = (name: string): string => {
      const key = name.toLowerCase();
      const existing = objectNameMap.get(key);
      if (existing) return existing;
      objectNameMap.set(key, name);
      return name;
    };

    const isObjectName = (name: string): boolean => {
      if (indexes.fieldNames.has(name)) return false;
      return objectNameMap.has(name.toLowerCase());
    };

    const isFieldName = (name: string): boolean => indexes.fieldNames.has(name);
    const isApexClass = (name: string): boolean => indexes.apexClassNames.has(name);
    const isKnownObject = (name: string): boolean => objectNameMap.has(name.toLowerCase());

    for (const file of files) {
      try {
        if (file.type === 'CustomObject') {
          const { component, dependencies } = this.objectParser.parse(file.path);
          objectNameMap.set(component.name.toLowerCase(), component.name);
          graphBuilder.addComponent(component);
          dependencies.forEach(dep => graphBuilder.addDependency(dep));
        } else if (file.type === 'ApexClass') {
          if (this.isTestClass(file.path)) continue;
          const { component, dependencies } = this.apexParser.parse(
            file.path,
            'ApexClass',
            resolveObjectName,
            isObjectName,
            isApexClass,
            isFieldName,
            isKnownObject
          );
          graphBuilder.addComponent(component);
          dependencies.forEach(dep => graphBuilder.addDependency(dep));
        } else if (file.type === 'ApexTrigger') {
          const { component, dependencies } = this.apexParser.parse(
            file.path,
            'ApexTrigger',
            resolveObjectName,
            isObjectName,
            isApexClass,
            isFieldName,
            isKnownObject
          );
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
          const lwcDeps = this.lwcParser.parse(file.path, componentId, isApexClass);
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
          const auraDeps = this.auraParser.parse(file.path, componentId, isApexClass);
          auraDeps.forEach(dep => graphBuilder.addDependency(dep));
        } else if (file.type === 'Flow') {
          const fileName = file.path.split('/').pop()!;
          const flowName = fileName.replace(/\.flow-meta\.xml$/, '');
          graphBuilder.addComponent({
            id: `Flow:${flowName}`,
            name: flowName,
            type: 'Flow',
            filePath: file.path,
          });
        }

        processed++;
        if (processed % 100 === 0) {
          console.log(`  ⚙️  Processed ${processed}/${files.length} files...`);
        }
        if (onProgress && (processed % 10 === 0 || processed === files.length)) {
          await (onProgress(processed, files.length) ?? Promise.resolve());
        }
      } catch (error) {
        console.warn(`  ⚠️  Failed to parse ${file.path}: ${error}`);
      }
    }

    console.log(`✅ Processed ${processed} metadata components`);

    const graph = graphBuilder.build();

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

  private buildObjectNameMap(indexes: MetadataIndexes): Map<string, string> {
    const map = new Map<string, string>();
    for (const obj of STANDARD_OBJECTS) {
      map.set(obj.toLowerCase(), obj);
    }
    for (const name of indexes.objectNames) {
      map.set(name.toLowerCase(), name);
    }
    return map;
  }
}
