import { readdirSync, statSync } from 'fs';
import { join } from 'path';

export interface MetadataFile {
  path: string;
  type: 'CustomObject' | 'ApexClass' | 'ApexTrigger' | 'Flow' | 'LWC' | 'Aura';
}

/** Pre-built indexes of all known metadata by type. Used to avoid false positives when parsing. */
export interface MetadataIndexes {
  objectNames: Set<string>;
  fieldNames: Set<string>;
  apexClassNames: Set<string>;
  apexTriggerNames: Set<string>;
  lwcNames: Set<string>;
  auraNames: Set<string>;
  flowNames: Set<string>;
}

export class MetadataScanner {
  /**
   * Single pass: scans objects/, classes/, triggers/, lwc/, aura/, flows/ and returns
   * both the file list and pre-built indexes. Indexes are the source of truth for
   * what exists; parsers only add dependencies when the target is in the index.
   */
  scanWithIndexes(sourceDir: string): { files: MetadataFile[]; indexes: MetadataIndexes } {
    const files: MetadataFile[] = [];
    const objectNames = new Set<string>();
    const fieldNames = new Set<string>();
    const apexClassNames = new Set<string>();
    const apexTriggerNames = new Set<string>();
    const lwcNames = new Set<string>();
    const auraNames = new Set<string>();
    const flowNames = new Set<string>();

    const walkDir = (dir: string) => {
      const entries = readdirSync(dir) as string[];

      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
          walkDir(fullPath);
        } else if (stat.isFile()) {
          if (entry.endsWith('.object-meta.xml')) {
            const objectName = fullPath.split('/').slice(-2, -1)[0];
            objectNames.add(objectName);
            files.push({ path: fullPath, type: 'CustomObject' });
          } else if (entry.endsWith('.field-meta.xml')) {
            const fieldApiName = entry.replace(/\.field-meta\.xml$/, '');
            fieldNames.add(fieldApiName);
          } else if (entry.endsWith('.cls')) {
            const name = entry.replace(/\.cls$/, '');
            apexClassNames.add(name);
            files.push({ path: fullPath, type: 'ApexClass' });
          } else if (entry.endsWith('.trigger')) {
            const name = entry.replace(/\.trigger$/, '');
            apexTriggerNames.add(name);
            files.push({ path: fullPath, type: 'ApexTrigger' });
          } else if (entry.endsWith('.flow-meta.xml')) {
            const name = entry.replace(/\.flow-meta\.xml$/, '');
            flowNames.add(name);
            files.push({ path: fullPath, type: 'Flow' });
          } else if (entry.endsWith('.js') && fullPath.includes('/lwc/') && !entry.endsWith('.js-meta.xml')) {
            const pathParts = fullPath.split('/');
            const parentDir = pathParts[pathParts.length - 2];
            const baseName = entry.replace(/\.js$/, '');
            if (parentDir === baseName) {
              lwcNames.add(baseName);
              files.push({ path: fullPath, type: 'LWC' });
            }
          } else if (fullPath.includes('/aura/') && (entry.endsWith('.cmp') || entry.endsWith('.app'))) {
            if (!entry.endsWith('-meta.xml')) {
              const name = entry.replace(/\.(cmp|app)$/, '');
              auraNames.add(name);
              files.push({ path: fullPath, type: 'Aura' });
            }
          }
        }
      }
    };

    walkDir(sourceDir);
    return {
      files,
      indexes: {
        objectNames,
        fieldNames,
        apexClassNames,
        apexTriggerNames,
        lwcNames,
        auraNames,
        flowNames,
      },
    };
  }

  /** @deprecated Use scanWithIndexes. Kept for backwards compatibility. */
  scan(sourceDir: string): MetadataFile[] {
    return this.scanWithIndexes(sourceDir).files;
  }
}
