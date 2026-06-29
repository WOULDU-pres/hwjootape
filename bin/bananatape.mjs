#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const SCHEMA_VERSION = 1;
const DEFAULT_APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_ROOT = path.resolve(process.env.NODE_ENV === 'test' && process.env.BANANATAPE_TEST_APP_ROOT ? process.env.BANANATAPE_TEST_APP_ROOT : DEFAULT_APP_ROOT);

function homeDir() { return os.homedir(); }
function runtimeDir() { return path.resolve(process.env.BANANATAPE_HOME || path.join(homeDir(), '.bananatape')); }
function projectsRoot() { return path.resolve(process.env.BANANATAPE_PROJECTS_DIR || path.join(homeDir(), 'Documents', 'BananaTape Projects')); }
function registryPath() { return path.join(runtimeDir(), 'projects.json'); }
function runtimePath() { return path.join(runtimeDir(), 'runtime.json'); }
function nowIso() { return new Date().toISOString(); }
function slugify(name) {
  // Unicode-aware: keep letters (incl. Korean/CJK) and numbers; everything else -> '-'.
  const slug = name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  if (!slug) throw new Error('Project name must include at least one letter or number.');
  return slug;
}
function projectPathFor(id, dir = projectsRoot()) { return path.join(path.resolve(dir), id); }

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}
async function readRegistry() {
  const registry = await readJson(registryPath(), { schemaVersion: SCHEMA_VERSION, projects: [] });
  return registry.schemaVersion === SCHEMA_VERSION && Array.isArray(registry.projects) ? registry : { schemaVersion: SCHEMA_VERSION, projects: [] };
}
async function writeRegistry(registry) { await writeJson(registryPath(), registry); }
async function readRuntime() {
  const registry = await readJson(runtimePath(), { schemaVersion: SCHEMA_VERSION, running: [] });
  return registry.schemaVersion === SCHEMA_VERSION && Array.isArray(registry.running) ? registry : { schemaVersion: SCHEMA_VERSION, running: [] };
}
async function writeRuntime(runtime) { await writeJson(runtimePath(), runtime); }
function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function cleanupRuntime() {
  const runtime = await readRuntime();
  const running = runtime.running.filter((entry) => isProcessAlive(entry.pid));
  if (running.length !== runtime.running.length) await writeRuntime({ schemaVersion: SCHEMA_VERSION, running });
  return { schemaVersion: SCHEMA_VERSION, running };
}
async function createProject(name, options) {
  const id = slugify(name);
  const root = projectPathFor(id, options.dir);
  const manifest = { schemaVersion: SCHEMA_VERSION, id, name: name.trim(), createdAt: nowIso(), updatedAt: nowIso() };
  await fs.mkdir(path.join(root, 'assets'), { recursive: true });
  await fs.mkdir(path.join(root, 'thumbnails'), { recursive: true });
  await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
  await fs.writeFile(path.join(root, 'project.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  await fs.writeFile(path.join(root, 'history.json'), `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, revision: 0, entries: [] }, null, 2)}\n`, { flag: 'wx' });
  const registry = await readRegistry();
  registry.projects = registry.projects.filter((project) => project.id !== id && project.path !== root);
  registry.projects.push({ id, name: manifest.name, path: root, createdAt: manifest.createdAt, lastOpenedAt: null });
  await writeRegistry(registry);
  console.log(`Created ${id}\n${root}`);
}
async function resolveProject(ref) {
  const registry = await readRegistry();
  const byId = registry.projects.find((project) => project.id === ref || project.name === ref);
  const projectPath = byId?.path || path.resolve(ref);
  const manifestPath = path.join(projectPath, 'project.json');
  const manifest = await readJson(manifestPath, null);
  if (!manifest || manifest.schemaVersion !== SCHEMA_VERSION || !manifest.id) throw new Error(`Not a BananaTape project: ${ref}`);
  return { id: manifest.id, name: manifest.name, path: projectPath, manifest };
}
async function listProjects() {
  const [registry, runtime] = await Promise.all([readRegistry(), cleanupRuntime()]);
  for (const project of registry.projects) {
    const running = runtime.running.find((entry) => entry.projectId === project.id);
    console.log(`${project.id}\t${running ? `running http://127.0.0.1:${running.port}` : 'stopped'}\t${project.path}`);
  }
}
async function status(ref) {
  const [registry, runtime] = await Promise.all([readRegistry(), cleanupRuntime()]);
  const project = ref ? registry.projects.find((entry) => entry.id === ref || entry.name === ref || entry.path === path.resolve(ref)) : null;
  const entries = ref
    ? runtime.running.filter((entry) => entry.projectId === ref || entry.projectPath === path.resolve(ref) || entry.projectId === project?.id)
    : runtime.running;
  if (entries.length === 0) {
    if (project) {
      console.log(`${project.id}\n  status: stopped\n  path: ${project.path}`);
      return;
    }
    console.log('No running BananaTape projects.');
    return;
  }
  for (const entry of entries) {
    console.log(`${entry.projectId}\n  status: running\n  url: http://127.0.0.1:${entry.port}\n  pid: ${entry.pid}\n  launchId: ${entry.launchId}`);
  }
}
async function deleteProject(ref, options) {
  const project = await resolveProject(ref);
  let registry = await readRegistry();
  registry.projects = registry.projects.filter((item) => item.id !== project.id);
  await writeRegistry(registry);
  if (options.deleteFiles) await fs.rm(project.path, { recursive: true, force: true });
  console.log(`${options.deleteFiles ? 'Deleted' : 'Unregistered'} ${project.id}`);
}
function parseOptions(args) {
  const options = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dir') options.dir = args[++i];
    else if (arg === '--port') options.port = Number(args[++i]);
    else if (arg === '--no-open') options.noOpen = true;
    else if (arg === '--rebuild') options.rebuild = true;
    else if (arg === '--delete-files') options.deleteFiles = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--style') options.style = args[++i];
    else if (arg === '--name') options.name = args[++i];
    else if (arg === '--theme') options.theme = args[++i];
    else if (arg === '--preset') options.preset = args[++i];
    else rest.push(arg);
  }
  return { options, rest };
}
async function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}
async function findFreePort(preferred) {
  if (preferred) {
    if (await isPortFree(preferred)) return preferred;
    throw new Error(`Port ${preferred} is already in use.`);
  }
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
async function pathExists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}
async function buildExists() {
  return pathExists(path.join(APP_ROOT, '.next', 'BUILD_ID'));
}
async function standaloneServerExists() {
  return pathExists(path.join(APP_ROOT, '.next', 'standalone', 'server.js'));
}
async function syncDirectoryIfPresent(source, destination) {
  if (!(await pathExists(source))) return;
  const parent = path.dirname(destination);
  const temporary = path.join(parent, `.${path.basename(destination)}-${process.pid}-${Date.now()}.tmp`);
  await fs.mkdir(parent, { recursive: true });
  await fs.rm(temporary, { recursive: true, force: true });
  try {
    await fs.cp(source, temporary, { recursive: true });
    await fs.rm(destination, { recursive: true, force: true });
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
async function prepareStandaloneServer() {
  const standaloneRoot = path.join(APP_ROOT, '.next', 'standalone');
  await syncDirectoryIfPresent(path.join(APP_ROOT, '.next', 'static'), path.join(standaloneRoot, '.next', 'static'));
  await syncDirectoryIfPresent(path.join(APP_ROOT, 'public'), path.join(standaloneRoot, 'public'));
}
function spawnBrowser(url) {
  if (process.platform === 'darwin') return spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  if (process.platform === 'win32') return spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
  return spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
}
async function launchProject(ref, options) {
  const project = await resolveProject(ref);
  const runtime = await cleanupRuntime();
  const existing = runtime.running.find((entry) => entry.projectId === project.id);
  if (existing && !options.port) {
    const url = `http://127.0.0.1:${existing.port}`;
    if (!options.noOpen) spawnBrowser(url);
    console.log(`${project.id} already running at ${url}`);
    return;
  }
  if (options.rebuild || !(await buildExists())) {
    console.log('Building BananaTape...');
    await new Promise((resolve, reject) => {
      const child = spawn('npm', ['run', 'build'], { cwd: APP_ROOT, stdio: 'inherit' });
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('Build failed')));
    });
  }
  const port = await findFreePort(options.port);
  const launchId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const hasStandaloneServer = await standaloneServerExists();
  if (hasStandaloneServer) await prepareStandaloneServer();
  const child = hasStandaloneServer
    ? spawn(process.execPath, [path.join(APP_ROOT, '.next', 'standalone', 'server.js')], {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        HOSTNAME: '127.0.0.1',
        PORT: String(port),
        BANANATAPE_ACTIVE_PROJECT_PATH: project.path,
        BANANATAPE_LAUNCH_ID: launchId,
      },
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    })
    : spawn('npm', ['run', 'start', '--', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      BANANATAPE_ACTIVE_PROJECT_PATH: project.path,
      BANANATAPE_LAUNCH_ID: launchId,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });
  child.unref();
  runtime.running.push({ projectId: project.id, projectPath: project.path, port, pid: child.pid, launchId, startedAt: nowIso() });
  await writeRuntime(runtime);
  const url = `http://127.0.0.1:${port}`;
  if (!options.noOpen) spawnBrowser(url);
  console.log(`Launched ${project.id} at http://127.0.0.1:${port}`);
}
const HUB_ID = '__hub__';

// Single-hub server: serves the deck dashboard for ALL projects (project chosen
// per-request via ?project=<id>), so no BANANATAPE_ACTIVE_PROJECT_PATH is set.
async function launchHub(options) {
  const runtime = await cleanupRuntime();
  const existing = runtime.running.find((entry) => entry.projectId === HUB_ID);
  if (existing && !options.port) {
    const url = `http://127.0.0.1:${existing.port}/decks`;
    if (!options.noOpen) spawnBrowser(url);
    console.log(`Hub already running at ${url}`);
    return;
  }
  if (options.rebuild || !(await buildExists())) {
    console.log('Building BananaTape...');
    await new Promise((resolve, reject) => {
      const child = spawn('npm', ['run', 'build'], { cwd: APP_ROOT, stdio: 'inherit' });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('Build failed'))));
    });
  }
  const port = await findFreePort(options.port);
  const launchId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const hasStandaloneServer = await standaloneServerExists();
  if (hasStandaloneServer) await prepareStandaloneServer();
  const child = hasStandaloneServer
    ? spawn(process.execPath, [path.join(APP_ROOT, '.next', 'standalone', 'server.js')], {
      cwd: APP_ROOT,
      env: { ...process.env, HOSTNAME: '127.0.0.1', PORT: String(port), BANANATAPE_LAUNCH_ID: launchId },
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    })
    : spawn('npm', ['run', 'start', '--', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: APP_ROOT,
      env: { ...process.env, BANANATAPE_LAUNCH_ID: launchId },
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    });
  child.unref();
  runtime.running.push({ projectId: HUB_ID, projectPath: '', port, pid: child.pid, launchId, startedAt: nowIso() });
  await writeRuntime(runtime);
  const url = `http://127.0.0.1:${port}/decks`;
  if (!options.noOpen) spawnBrowser(url);
  console.log(`Hub running at ${url}`);
}

async function stopProject(ref, options) {
  const runtime = await readRuntime();
  const keep = [];
  for (const entry of runtime.running) {
    const match = options.all || entry.projectId === ref || entry.projectPath === path.resolve(ref || '');
    if (match) {
      try { process.kill(entry.pid, 'SIGTERM'); } catch {}
      console.log(`Stopped ${entry.projectId}`);
    } else keep.push(entry);
  }
  await writeRuntime({ schemaVersion: SCHEMA_VERSION, running: keep });
}
async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status} from ${url}`);
  return data;
}

// Minimal outline parser for the CLI (first slide only); mirrors src/lib/slides/deck.ts.
function parseOutlineMarkdown(md) {
  const title = [];
  const bullets = [];
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^---+$/.test(line)) break;
    const heading = line.match(/^#{1,6}\s+(.*\S)/);
    if (heading) { if (!title.length) title.push(heading[1]); else bullets.push(heading[1]); continue; }
    const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.*\S)/);
    if (bullet) { bullets.push(bullet[1]); continue; }
    if (!title.length) title.push(line); else bullets.push(line);
  }
  return { title: title[0] || '', bullets };
}

async function waitForServer(url, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const response = await fetch(url); if (response.ok || response.status === 404) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Server did not become ready within ${Math.round(timeoutMs / 1000)}s: ${url}`);
}

async function deckCommand(ref, file, options) {
  if (!ref || !file) throw new Error('Usage: bananatape deck <project> <outline.md> [--preset <id>] [--style <hint>] [--name <basename>]');
  const project = await resolveProject(ref);
  let runtime = await cleanupRuntime();
  let entry = runtime.running.find((item) => item.projectId === project.id);
  if (!entry) {
    console.log(`${project.id} is not running — launching it...`);
    await launchProject(project.id, { noOpen: true });
    runtime = await cleanupRuntime();
    entry = runtime.running.find((item) => item.projectId === project.id);
    if (!entry) throw new Error(`Failed to launch ${project.id}.`);
    process.stdout.write('Waiting for the editor server to be ready');
    await waitForServer(`http://127.0.0.1:${entry.port}/deck`);
    console.log(' ready.');
  }
  const base = `http://127.0.0.1:${entry.port}`;
  // Thread the project id into every API call (single-hub model resolves the
  // deck via ?project=<id>; harmless under the per-project launch model too).
  const api = (p) => `${base}${p}?project=${encodeURIComponent(project.id)}`;
  const outlineText = await fs.readFile(path.resolve(file), 'utf8');
  if (!outlineText.trim()) throw new Error(`Outline file is empty: ${file}`);

  // The web flow lets the user pick from N visual versions; the CLI is headless, so it
  // bakes ONE chosen style preset (default 'minimal', override with --preset <id>).
  const presetId = options.preset || 'minimal';

  // 1. Versions: render the chosen preset's sample slides (the picker's input).
  console.log(`Generating sample design for preset "${presetId}" (god-tibo, may take a while)...`);
  const versionsRes = await postJson(api('/api/slides/versions'), {
    outlineText,
    styleHint: options.style,
    presetIds: [presetId],
  });
  const chosen = (versionsRes.versions || [])[0];
  if (!chosen) throw new Error(`No version produced for preset "${presetId}".`);
  const samples = {};
  for (const sm of chosen.samples || []) if (sm.assetId) samples[sm.slideIndex] = sm.assetId;

  // 2. Full deck: render the remaining slides in the chosen look (samples as references).
  console.log('Generating the full deck in that style...');
  const deckRes = await postJson(api('/api/slides/full-deck'), {
    outlineText,
    presetId,
    styleHint: options.style,
    samples,
  });
  const slides = (deckRes.slides || []).filter((s) => s.assetId).map((s) => ({ slideIndex: s.slideIndex, assetId: s.assetId }));
  console.log(`Generated ${slides.length} slide image(s).`);

  // 3. Decompose: OCR + gpt-5.5 mapping + background/object regen → editable specs.
  console.log('Decomposing into editable elements (OCR + SAM3 + gpt-5.5)...');
  const decomposed = await postJson(api('/api/slides/decompose-deck'), {
    outlineText,
    styleHint: options.style,
    slides,
  });

  // 4. Export: render the final deck to editable pptx + per-slide png.
  console.log(`Exporting (${decomposed.deck.length} slide(s))...`);
  const exported = await postJson(api('/api/slides/export'), {
    deck: decomposed.deck,
    baseName: options.name || 'deck',
  });
  console.log(`\nDone (${exported.slideCount} slide(s)):\n  pptx: ${exported.pptxPath}`);
  for (const png of exported.pngPaths) console.log(`  png:  ${png}`);
  console.log(`  exports: ${path.dirname(exported.pptxPath)}`);
}

async function newCommand(name, options) {
  if (!name) throw new Error('Usage: hwjootape new <name>');
  await createProject(name, options);
  const id = slugify(name);
  // Create on the single hub, then open the new deck's builder there.
  await launchHub({ ...options, noOpen: true });
  const runtime = await cleanupRuntime();
  const hub = runtime.running.find((entry) => entry.projectId === HUB_ID);
  if (!hub) throw new Error('Failed to start the hub server.');
  const url = `http://127.0.0.1:${hub.port}/deck?project=${encodeURIComponent(id)}`;
  if (!options.noOpen) spawnBrowser(url);
  console.log(`Opened ${id} at ${url}`);
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function interactiveMenu() {
  const [registry, runtime] = await Promise.all([readRegistry(), cleanupRuntime()]);
  const projects = registry.projects;
  console.log('\n  🍌  hwjootape — AI 덱 생성기\n');
  if (projects.length === 0) {
    console.log('  아직 덱이 없습니다.');
  } else {
    console.log('  덱 목록:');
    projects.forEach((project, index) => {
      const running = runtime.running.find((entry) => entry.projectId === project.id);
      const status = running ? `실행 중 · http://127.0.0.1:${running.port}` : '중지됨';
      console.log(`    ${index + 1}. ${project.id}  (${status})`);
    });
  }
  console.log('\n    n. 새로 만들기');
  console.log('    q. 종료\n');

  if (!process.stdin.isTTY) {
    console.log('  (대화형 입력 불가 — `hwjootape new "이름"` 또는 `hwjootape launch <덱>`을 쓰세요.)');
    return;
  }

  const choice = await ask('  선택> ');
  if (!choice || choice === 'q') return;
  if (choice === 'n') {
    const name = await ask('  새 덱 이름> ');
    if (!name) { console.log('  취소했습니다.'); return; }
    return newCommand(name, {});
  }
  const index = Number(choice) - 1;
  if (Number.isInteger(index) && projects[index]) {
    return launchProject(projects[index].id, {});
  }
  console.log('  알 수 없는 선택입니다.');
}

function usage() {
  console.log(`hwjootape / bananatape\n\nRun with no command to open the web dashboard (덱 목록 + 새로 만들기).\n\nCommands:\n  hwjootape                             open the deck dashboard in your browser (hub)\n  hwjootape new <name>                  create a deck and open its builder in one step\n  hwjootape menu                        text-only menu (for headless terminals)\n  hwjootape create <name> [--dir <parent>]\n  hwjootape list\n  hwjootape launch <project> [--port <port>] [--no-open] [--rebuild]\n  hwjootape open <project>\n  hwjootape status [project]\n  hwjootape stop <project|--all>\n  hwjootape delete <project> [--delete-files]\n  hwjootape deck <project> <outline.md> [--preset <id>] [--style <hint>] [--name <basename>]\n        (auto-launches the project if it is not already running)`);
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  const { options, rest } = parseOptions(args);
  if (command === 'help' || command === '--help') return usage();
  if (!command) return launchHub(options);
  if (command === 'hub') return launchHub(options);
  if (command === 'menu') return interactiveMenu();
  if (command === 'new') return newCommand(rest.join(' '), options);
  if (command === 'create') return createProject(rest.join(' '), options);
  if (command === 'list') return listProjects();
  if (command === 'launch' || command === 'open') return launchProject(rest[0], options);
  if (command === 'status') return status(rest[0]);
  if (command === 'stop') return stopProject(rest[0], options);
  if (command === 'delete') return deleteProject(rest[0], options);
  if (command === 'deck') return deckCommand(rest[0], rest[1], options);
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
