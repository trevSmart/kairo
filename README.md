# Kairo 🎯

Web app per seleccionar repos de projectes Salesforce i visualitzar-los amb graf de dependencies i llista de components.

## Quick Start

```bash
npm install
npm start
```

Obre http://localhost:3456 i afegeix projectes Salesforce (rutes a carpetes de metadata). En obrir la list view o graph view d'un projecte, l'anàlisi es genera automàticament.

## Project Structure

```
kairo/
├── src/
│   ├── parsers/       # Metadata parsers (Objects, Apex, LWC, Aura)
│   ├── graph/         # Graph construction
│   ├── viz/           # List view, graph view, homepage
│   ├── analyzer.ts
│   ├── index.ts       # Entry point
│   ├── server.ts      # HTTP server
│   └── types.ts
├── config/
│   └── projects.json  # Default Salesforce projects (optional)
└── tests/
```

## Development

```bash
npm run dev    # Start with tsx
npm test       # Run tests
npm run build  # Compile TypeScript
```

## License

MIT
