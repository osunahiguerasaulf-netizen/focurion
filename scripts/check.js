const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = [
  'server.js',
  'public/js/app.js',
  'public/js/auth.js',
  'public/js/icons.js'
];

let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding:'utf8' });
  if (result.status === 0) {
    console.log(`✓ ${file}`);
  } else {
    failed = true;
    console.error(`✗ ${file}`);
    console.error(result.stderr || result.stdout);
  }
}

if (failed) process.exit(1);
console.log('Verificación de sintaxis completada.');
