import { readdirSync, statSync } from 'fs';
import { join } from 'path';

export interface MetadataFile {
  path: string;
  type: 'CustomObject' | 'ApexClass' | 'ApexTrigger' | 'Flow' | 'LWC' | 'Aura';
}

export class MetadataScanner {
  scan(sourceDir: string): MetadataFile[] {
    const files: MetadataFile[] = [];

    const walkDir = (dir: string) => {
      const entries = readdirSync(dir);

      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
          walkDir(fullPath);
        } else if (stat.isFile()) {
          // CustomObject metadata
          if (entry.endsWith('.object-meta.xml')) {
            files.push({ path: fullPath, type: 'CustomObject' });
          }
          // Apex classes
          else if (entry.endsWith('.cls')) {
            files.push({ path: fullPath, type: 'ApexClass' });
          }
          // Apex triggers
          else if (entry.endsWith('.trigger')) {
            files.push({ path: fullPath, type: 'ApexTrigger' });
          }
          // Flows
          else if (entry.endsWith('.flow-meta.xml')) {
            files.push({ path: fullPath, type: 'Flow' });
          }
          // LWC: one entry per component (main module only: folderName/folderName.js)
          else if (entry.endsWith('.js') && fullPath.includes('/lwc/') && !entry.endsWith('.js-meta.xml')) {
            const parentDir = fullPath.split('/').slice(-2, -1)[0];
            const baseName = entry.replace(/\.js$/, '');
            if (parentDir === baseName) {
              files.push({ path: fullPath, type: 'LWC' });
            }
          }
          // Aura: component or application (one entry per .cmp or .app)
          else if (fullPath.includes('/aura/') && (entry.endsWith('.cmp') || entry.endsWith('.app'))) {
            if (!entry.endsWith('-meta.xml')) {
              files.push({ path: fullPath, type: 'Aura' });
            }
          }
        }
      }
    };

    walkDir(sourceDir);
    return files;
  }
}
