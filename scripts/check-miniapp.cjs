const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../miniapp');
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else files.push(file);
  }
}
function requireFile(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing miniapp file: ${path.relative(root, file)}`);
}
function baseFiles(base) {
  for (const ext of ['.js', '.json', '.wxml', '.wxss']) requireFile(`${base}${ext}`);
}
walk(root);
const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
for (const page of app.pages) baseFiles(path.join(root, page));
for (const file of files) {
  if (file.endsWith('.json') && file !== path.join(root, 'app.json')) {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [tag, reference] of Object.entries(config.usingComponents || {})) {
      const base = reference.startsWith('/') ? path.join(root, reference.slice(1)) : path.resolve(path.dirname(file), reference);
      baseFiles(base);
      const wxml = file.replace(/\.json$/, '.wxml');
      if (fs.existsSync(wxml) && !fs.readFileSync(wxml, 'utf8').includes(`<${tag}`)) throw new Error(`Unused component registration: ${tag} in ${wxml}`);
    }
  }
  if (file.endsWith('.js')) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\brequire\s*\(([^)]+)\)/g)) {
      if (!/^['"]\.{1,2}\//.test(match[1])) throw new Error(`Unsupported miniapp require in ${file}: ${match[0]}`);
      const target = path.resolve(path.dirname(file), match[1].slice(1, -1));
      if (!fs.existsSync(`${target}.js`) && !fs.existsSync(path.join(target, 'index.js'))) throw new Error(`Missing require target: ${match[0]} in ${file}`);
    }
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:appsecret|api[_-]?key|database[_-]?url)\s*[:=]\s*['"][^'"]{12,}['"]/i.test(source)) throw new Error(`Possible embedded secret in ${file}`);
  }
}
console.log('Miniapp paths, references, registrations and secret patterns: OK');
