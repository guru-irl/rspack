import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve('benchmark-app');
fs.mkdirSync(path.join(root, 'src/routes'), { recursive: true });
fs.mkdirSync(path.join(root, 'src/data'), { recursive: true });
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
  name: 'tanstack-reference-filter-fixture', private: true, type: 'module',
  dependencies: { '@rspack/core': '2.2.8', '@tanstack/router-plugin': '1.168.42',
    '@tanstack/react-router': 'latest', react: '19.2.0', 'react-dom': '19.2.0',
    vite: '7.3.1', picomatch: '4.0.3' },
}, null, 2));
fs.writeFileSync(path.join(root, 'src/routes/__root.tsx'), `import React from 'react';
import { createRootRoute, Outlet } from '@tanstack/react-router';
export const Route = createRootRoute({ component: () => React.createElement(Outlet) });\n`);
for (let r = 0; r < 200; r++) {
  const name = `r${String(r).padStart(3, '0')}`;
  const imports = [];
  const values = [];
  for (let m = 0; m < 100; m++) {
    const index = r * 100 + m;
    const file = `m${String(index).padStart(5, '0')}`;
    const extension = index % 2 ? 'tsx' : 'ts';
    fs.writeFileSync(path.join(root, `src/data/${file}.${extension}`), `export const value = ${index};\n`);
    imports.push(`import { value as v${m} } from '../data/${file}';`);
    values.push(`v${m}`);
  }
  fs.writeFileSync(path.join(root, `src/routes/${name}.tsx`), `import React from 'react';
import { createFileRoute } from '@tanstack/react-router';
${imports.join('\n')}
const sharedValue = [${values.join(',')}].reduce((a, b) => a + b, 0);
export const Route = createFileRoute('/${name}')({
  loader: () => sharedValue,
  component: () => React.createElement('div', null, sharedValue),
});\n`);
}
fs.writeFileSync(path.join(root, 'src/main.tsx'), `import React from 'react';
import { createRoot } from 'react-dom/client';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
const router = createRouter({ routeTree });
createRoot(document.getElementById('root')!).render(React.createElement(RouterProvider, { router }));\n`);
fs.writeFileSync(path.join(root, 'index.html'), '<div id="root"></div><script type="module" src="/src/main.tsx"></script>\n');
console.log('Generated 200 routes, one root route and 20000 data modules.');
