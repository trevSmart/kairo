# Kairo 🎯

Salesforce org metadata analyzer that reverse-engineers business processes from technical metadata.

## What it does

Kairo analyzes Salesforce metadata to:

1. **Extract** all components (Objects, Apex, Flows, etc.)
2. **Build** a dependency graph showing how components relate
3. **Visualize** the graph as an interactive HTML
4. **Identify** functional clusters (coming soon)
5. **Generate** business process documentation (coming soon)

## Quick Start

```bash
# Install dependencies
npm install

# Analyze the test data (Vodafone org)
npm run analyze

# View the result
open output/dependency-graph.html
```

## Usage

```bash
# Analyze custom metadata location
npm run dev -- analyze --source /path/to/salesforce/metadata

# Or after building
npm run build
npm start -- analyze --source ./test-data --output ./output
```

## Project Structure

```
kairo/
├── src/
│   ├── parsers/          # Metadata parsers (Objects, Apex, Flows)
│   ├── graph/            # Graph construction
│   ├── viz/              # HTML visualization
│   ├── analyzer.ts       # Main analysis orchestrator
│   ├── cli.ts            # CLI interface
│   └── types.ts          # TypeScript types
├── test-data/            # Sample Salesforce org metadata (for testing)
├── output/               # Analysis results (generated)
└── tests/                # Unit tests (coming soon)
```

## How it works

### 1. Metadata Scanning
Recursively finds all Salesforce metadata files:
- `.object-meta.xml` → CustomObjects
- `.cls` → Apex classes
- `.trigger` → Apex triggers
- `.flow-meta.xml` → Flows

### 2. Parsing & Extraction
Each parser extracts:
- **Component identity**: name, type, label
- **Dependencies**: what this component uses/references

Example: A CustomObject parser finds:
- Lookup relationships → dependencies to other objects
- Formula fields → references to other objects

### 3. Graph Construction
Builds a directed graph using [Graphology](https://graphology.github.io/):
- **Nodes** = metadata components
- **Edges** = dependencies (uses, references, triggers_on, etc.)

### 4. Visualization
Generates interactive HTML using [vis-network](https://visjs.github.io/vis-network/):
- Color-coded by component type
- Clickable nodes show details
- Physics simulation for automatic layout

## Roadmap

- [x] Parse CustomObjects (relationships, formulas)
- [x] Parse Apex (classes, triggers, SOQL, DML)
- [x] Build dependency graph
- [x] Interactive HTML visualization
- [ ] Parse Flows (logic, field updates, decisions)
- [ ] Parse LWC components
- [ ] **Clustering**: Group components into functional areas
- [ ] **Semantic analysis**: Use embeddings to understand naming patterns
- [ ] **Auto-naming**: Generate business process names
- [ ] **Traceability matrix**: Export component ↔ process mapping
- [ ] **CLI improvements**: Filter by type, depth limits, exclusions
- [ ] **Export formats**: JSON, CSV, Markdown, Mermaid diagrams

## Development

```bash
# Run in dev mode
npm run dev -- analyze

# Run tests
npm test

# Type check
npx tsc --noEmit

# Format code
npm run format
```

## License

MIT
