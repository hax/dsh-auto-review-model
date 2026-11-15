#!/usr/bin/env node
/**
 * Static and smoke verification for `@aghost-prj/dsh-auto-review-model`.
 *
 * This script does not install anything and never invokes pnpm/DSH commands.
 * It checks the package metadata, the Cordis patch, the host/client source
 * invariants the plugin relies on, the hand-written Typert faces the Loader and
 * Client mount, and that the development schemastery link is importable and
 * every JavaScript entry parses. It also re-reads the installed experimental
 * auto-review source to confirm the fixed policy prefix and marker sentence the
 * host listener keys on are still present.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Compiled file lives at .build/scripts/verify.js, so ROOT is ../../
const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const PACKAGE_NAME = '@aghost-prj/dsh-auto-review-model';
const TARGET_BUNDLE = '@deepseek-ai/dsh-experimental-auto-review';
const SETTINGS_NS = 'auto-review-model';
const REVIEW_POLICY_PREFIX = 'REVIEW_POLICY\n';
const REVIEW_POLICY_MARKER =
  'You are the final authorization reviewer for exactly one pending tool call.';
/** Candidate locations of the installed experimental auto-review package, in lookup order. */
const INSTALLED_AUTO_REVIEW_CANDIDATES: string[] = [
  ...(process.env.DSH_INSTALL_DIR === undefined
    ? []
    : [path.join(path.dirname(process.env.DSH_INSTALL_DIR), 'dsh-experimental-auto-review', 'lib', 'index.js')]),
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-experimental-auto-review/lib/index.js',
];

/**
 * Read a Host file, using the running Electron executable for Desktop's ASAR.
 * Ordinary Node cannot traverse `app.asar`; the packaged runtime can. The
 * bounded child process never invokes a shell or mutates the installation.
 */
function readInstalledSource(candidate: string): string | undefined {
  try {
    return readFileSync(candidate, 'utf8');
  } catch {
    // Try the Desktop runtime below when this is an ASAR-resident package.
  }
  const electron = process.env.DSH_NODE_EXECUTABLE;
  if (electron === undefined || !candidate.includes(`${path.sep}app.asar${path.sep}`)) return undefined;
  const script = [
    "const fs = require('node:fs')",
    'try { process.stdout.write(fs.readFileSync(process.argv[1], \'utf8\')) }',
    'catch { process.exit(2) }',
  ].join('\n');
  const result = spawnSync(electron, ['-e', script, candidate], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10_000,
  });
  return result.error === undefined && result.status === 0 ? result.stdout : undefined;
}

interface Failure {
  label: string;
  message: string;
}

const failures: Failure[] = [];
let passed = 0;

function read(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function check(label: string, callback: () => string | void | Promise<string | void>): Promise<void> {
  try {
    const detail = await callback();
    passed += 1;
    console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ label, message });
    console.error(`FAIL  ${label}`);
    console.error(`      ${message}`);
  }
}

/** Resolve one `exports` entry, which may be a string or a conditions object. */
function exportTarget(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  if (entry === null || typeof entry !== 'object') return '';
  const obj = entry as Record<string, unknown>;
  for (const condition of ['default', 'import', 'node', 'require']) {
    const target = exportTarget(obj[condition]);
    if (target !== '') return target;
  }
  return '';
}

function sameRelativeTarget(target: string, expected: string): boolean {
  return target.replace(/^\.\//, '') === expected;
}

function packageJson(): Record<string, any> {
  return JSON.parse(read('package.json'));
}

await check('package.json identity and entry metadata', () => {
  const pkg = packageJson();
  assert(pkg.name === PACKAGE_NAME, `name must be ${PACKAGE_NAME}, got ${pkg.name}`);
  assert(pkg.version === '0.1.0', `version must be 0.1.0, got ${pkg.version}`);
  assert(pkg.type === 'module', `type must be module, got ${pkg.type}`);
  assert(pkg.main === 'lib/index.js', `main must be lib/index.js, got ${pkg.main}`);
  return `${pkg.name}@${pkg.version}`;
});

await check('package.json exports cover host, policy, client and patch files', () => {
  const { exports } = packageJson();
  assert(exports !== null && typeof exports === 'object', 'exports must be an object');
  assert(
    sameRelativeTarget(exportTarget(exports['.']), 'lib/index.js'),
    'exports["."] must resolve to ./lib/index.js',
  );
  assert(
    Object.hasOwn(exports, './policy'),
    'exports must expose ./policy',
  );
  assert(
    sameRelativeTarget(exportTarget(exports['./policy']), 'lib/policy.js'),
    'exports["./policy"] must resolve to ./lib/policy.js',
  );
  assert(
    sameRelativeTarget(exportTarget(exports['./client']), 'client/client.js'),
    'exports["./client"] must resolve to ./client/client.js',
  );
  assert(
    Object.hasOwn(exports, './cordis.patch.yml'),
    'exports must expose ./cordis.patch.yml',
  );
  assert(Object.hasOwn(exports, './package.json'), 'exports must expose ./package.json');
  assert(
    sameRelativeTarget(exportTarget(exports['./typert']), 'lib/typert.host.js'),
    'exports["./typert"] must resolve to ./lib/typert.host.js (typert-loader discovery)',
  );
  assert(
    sameRelativeTarget(exportTarget(exports['./remote']), 'lib/typert.remote-client.js'),
    'exports["./remote"] must resolve to ./lib/typert.remote-client.js (Client mount)',
  );
  return 'exports: ., ./policy, ./client, ./typert, ./remote, ./cordis.patch.yml, ./package.json';
});

await check('package.json does not reference missing client runtime/ui-slots packages', () => {
  const pkg = packageJson();
  const serialized = JSON.stringify(pkg);
  assert(
    !serialized.includes('dsh-client-runtime'),
    'package.json must not reference @deepseek-ai/dsh-client-runtime',
  );
  assert(
    !serialized.includes('dsh-client-ui-slots'),
    'package.json must not reference @deepseek-ai/dsh-client-ui-slots',
  );
  return 'no dsh-client-runtime or dsh-client-ui-slots';
});

await check('package.json dsh bundle/client declarations and schemastery dependency', () => {
  const pkg = packageJson();
  assert(
    pkg.dsh?.bundle?.patch === './cordis.patch.yml',
    'dsh.bundle.patch must be ./cordis.patch.yml',
  );
  assert(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform must be web');
  const schemastery = pkg.dependencies?.['@deepseek-ai/schemastery'];
  assert(
    typeof schemastery === 'string' && schemastery.trim() !== '',
    'dependencies["@deepseek-ai/schemastery"] must be a non-empty version string',
  );
  return `schemastery ${schemastery}`;
});

await check('cordis.patch.yml declares the loader row', () => {
  const yml = read('cordis.patch.yml');
  assert(
    /^\s*-\s*id:\s*['"]?auto-review-model['"]?\s*$/m.test(yml),
    'cordis.patch.yml must contain "id: auto-review-model"',
  );
  assert(
    /^\s*name:\s*['"]@aghost-prj\/dsh-auto-review-model['"]\s*$/m.test(yml),
    "cordis.patch.yml must contain name '@aghost-prj/dsh-auto-review-model'",
  );
  return 'id auto-review-model';
});

await check('lib/policy.js keeps the REVIEW_POLICY prefix and marker sentence', () => {
  const source = read('lib/policy.js');
  assert(source.includes('REVIEW_POLICY'), 'lib/policy.js must define REVIEW_POLICY');
  assert(
    /REVIEW_POLICY(?:\\n|\r?\n)/.test(source),
    'lib/policy.js must define the "REVIEW_POLICY\\n" prefix',
  );
  assert(
    source.includes(REVIEW_POLICY_MARKER),
    'lib/policy.js must keep the fixed reviewer marker sentence',
  );
  return 'prefix + marker';
});

await check('lib/index.js installs the llm/stream waterfall with recursion guard', () => {
  const source = read('lib/index.js');
  assert(source.includes('llm/stream'), 'lib/index.js must listen on llm/stream');
  assert(source.includes('WeakSet'), 'lib/index.js must guard re-entry with WeakSet');
  return 'llm/stream + WeakSet';
});

await check('client/client.js targets the auto-review bundle settings namespace', () => {
  const source = read('client/client.js');
  assert(
    source.includes(TARGET_BUNDLE),
    `client/client.js must contain TARGET_BUNDLE ${TARGET_BUNDLE}`,
  );
  assert(
    source.includes(SETTINGS_NS),
    `client/client.js must contain SETTINGS_NS ${SETTINGS_NS}`,
  );
  assert(
    source.includes('plugins.bundle.config'),
    'client/client.js must register into plugins.bundle.config',
  );
  return `${TARGET_BUNDLE} / ${SETTINGS_NS}`;
});

await check('package.json declares no runtime dependency for the hand-written Typert faces', () => {
  const pkg = packageJson();
  const runtime = { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
  assert(!('zod' in runtime), 'the hand-written Typert artifacts must not require zod');
  for (const name of Object.keys(runtime)) {
    assert(
      !name.startsWith('@deepseek-ai/dsh-typert') && !name.startsWith('@deepseek-ai/dsh-api-gateway'),
      `a linked plugin cannot resolve ${name} from the DSH installation`,
    );
  }
  return 'no zod / Typert runtime dependency';
});

await check('./typert exports a Loader-valid manifest with one strict invocation', async () => {
  const module = await import(pathToFileURL(path.join(ROOT, 'lib', 'typert.host.js')).href) as {
    TYPERT?: {
      package?: string;
      face?: string;
      schemas?: Array<{ name?: string; create?: unknown }>;
      model?: { services?: unknown[]; events?: unknown[]; objects?: unknown[] };
      invocations?: Array<{
        id?: string;
        service?: string;
        namespace?: string;
        method?: string;
        invocation?: { kind?: string };
        parameters?: unknown[];
        cancellation?: { parameter?: string };
        result?: { mode?: string; typeSymbol?: string; create?: unknown; jsonSchema?: any };
      }>;
    };
  };
  const manifest = module.TYPERT;
  assert(manifest !== undefined, 'lib/typert.host.js must export TYPERT');
  assert(manifest.package === PACKAGE_NAME, `TYPERT.package must be ${PACKAGE_NAME}`);
  assert(manifest.face === 'host', 'TYPERT.face must be "host"');
  assert(Array.isArray(manifest.schemas), 'TYPERT.schemas must be an array');
  for (const schema of manifest.schemas ?? []) {
    assert(typeof schema.name === 'string' && schema.name !== '', 'each schema needs a name');
    assert(typeof schema.create === 'function', `schema ${schema.name} needs create()`);
  }
  for (const key of ['services', 'events', 'objects'] as const) {
    assert(Array.isArray(manifest.model?.[key]), `TYPERT.model.${key} must be an array`);
  }
  assert(Array.isArray(manifest.invocations), 'TYPERT.invocations must be an array');
  assert(manifest.invocations?.length === 1, 'exactly one Remote invocation must be contributed');
  const invocation = manifest.invocations?.[0];
  assert(invocation !== undefined, 'the invocation must exist');
  assert(invocation.id === `${PACKAGE_NAME}#autoReviewModel/testReviewRoute`, 'invocation id must be stable');
  assert(invocation.service === 'autoReviewModel', 'invocation service must be autoReviewModel');
  assert(invocation.namespace === 'autoReviewModel', 'invocation namespace must be autoReviewModel');
  assert(invocation.method === 'testReviewRoute', 'invocation method must be testReviewRoute');
  assert(invocation.invocation?.kind === 'direct', 'the endpoint must be a direct Service invocation');
  assert(Array.isArray(invocation.parameters) && invocation.parameters.length === 0, 'no browser wire parameters are accepted');
  assert(invocation.cancellation?.parameter === 'signal', 'the transport cancellation signal must be declared');
  assert(invocation.result?.mode === 'strict', 'the result codec must be strict');
  assert(typeof invocation.result?.typeSymbol === 'string' && invocation.result.typeSymbol !== '', 'the result codec needs a type symbol');
  assert(typeof invocation.result?.create === 'function', 'the result codec needs a create() factory');
  const codes: unknown = invocation.result?.jsonSchema?.properties?.code?.enum;
  assert(Array.isArray(codes), 'the result schema must enumerate outcome codes');
  for (const code of ['OK', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'AUTH', 'ACCOUNT_SIGN_IN_REQUIRED', 'ACCOUNT_AUTH_FAILED', 'ACCOUNT_CONNECTION', 'NO_ADAPTER', 'TIMEOUT', 'RATE_LIMIT', 'RATE_LIMITED', 'ROUTE_INCOMPLETE', 'EMPTY_RESPONSE', 'UNKNOWN']) {
    assert(codes.includes(code), `the result schema must enumerate ${code}`);
  }
  return `1 invocation: ${String(invocation.service)}/${String(invocation.method)} (${codes.length} codes)`;
});

await check('./remote exports the mountable contribution matching the Host descriptor', async () => {
  const [host, remote] = await Promise.all([
    import(pathToFileURL(path.join(ROOT, 'lib', 'typert.host.js')).href),
    import(pathToFileURL(path.join(ROOT, 'lib', 'typert.remote-client.js')).href),
  ]) as [
    { TYPERT: { invocations: Array<Record<string, unknown>> } },
    { TYPERT_REMOTE?: { package?: string; descriptors?: Array<Record<string, any>> }; default?: unknown },
  ];
  const contribution = remote.TYPERT_REMOTE;
  assert(contribution !== undefined, 'lib/typert.remote-client.js must export TYPERT_REMOTE');
  assert(remote.default === contribution, 'the remote artifact must default-export its contribution');
  assert(contribution.package === PACKAGE_NAME, 'the contribution must be owned by this package');
  assert(Array.isArray(contribution.descriptors) && contribution.descriptors.length === 1, 'exactly one descriptor must be mountable');
  const descriptor = contribution.descriptors[0];
  const hostDescriptor = host.TYPERT.invocations[0] as Record<string, any>;
  assert(descriptor?.id === hostDescriptor.id, 'Host and Client descriptor ids must match');
  assert(descriptor?.result?.typeSymbol === hostDescriptor.result.typeSymbol, 'Host and Client type symbols must match');
  const parsed = hostDescriptor.result.create().parse({
    status: 'ok',
    code: 'OK',
    route: { provider: 'p', model: 'm', reasoningEffort: '' },
    authKind: 'account',
    providerName: 'P',
    settingsNs: 'p',
    credentialEnv: [],
    effortUsed: '',
    effortNotAdvertised: false,
    latencyMs: 1,
    retryAfterMs: 0,
    failureCode: '',
    detail: '',
  });
  assert(parsed.code === 'OK', 'the strict codec must accept a documented result');
  let rejected = false;
  try {
    hostDescriptor.result.create().parse({ status: 'ok', code: 'OK', prose: 'model output' });
  } catch {
    rejected = true;
  }
  assert(rejected, 'the strict result codec must reject undeclared fields such as model prose');
  return 'Host/Client descriptors aligned, strict codec rejects undeclared fields';
});

await check('client/client.js embeds the ./remote contribution and mounts it', () => {
  const source = read('client/client.js');
  assert(source.includes('generated-client-remote-prelude'), 'the bundle must start with the generated contract prelude');
  assert(source.includes('client-bundle-body'), 'the bundle must keep the tsc body after the prelude');
  assert(source.includes('createRemoteContribution'), 'the bundle must construct the mounted contribution');
  assert(source.includes('@aghost-prj/dsh-auto-review-model/client.remote.js'), 'the bundle body must require the embedded ./remote module');
  assert(source.includes('$mount'), 'the client must mount the contribution through ctx.remote.$mount()');
  assert(
    /chunk:\s*contract\.REMOTE_CHUNK_FILE/.test(source) || /chunk:\s*['"]client\.remote\.js['"]/.test(source),
    'the contribution must register as the package-local client.remote.js chunk',
  );
  return 'prelude + main factory + $mount';
});

await check('hand-written Typert artifacts import no runtime package', () => {
  for (const relativePath of ['lib/typert.host.js', 'lib/typert.remote-client.js', 'lib/typert.contract.js']) {
    const source = read(relativePath);
    assert(
      !/from\s+['"](?:zod|@deepseek-ai\/)/.test(source) && !/require\(['"](?:zod|@deepseek-ai\/)/.test(source),
      `${relativePath} must not import zod or a Harness package`,
    );
  }
  return '3 artifacts dependency-free';
});

await check('Host entry publishes the autoReviewModel endpoint for the manifest', () => {
  const source = read('lib/index.js');
  assert(source.includes('installRouteTestEndpoint'), 'lib/index.js must install the saved-route endpoint');
  assert(source.includes('autoReviewModel'), 'lib/index.js must publish the endpoint names the manifest declares');
  return 'installRouteTestEndpoint wired';
});

await check('node_modules/@deepseek-ai/schemastery is importable', async () => {
  const schemastery = await import('@deepseek-ai/schemastery');
  const z = (schemastery as any).default ?? schemastery;
  assert(z !== null && z !== undefined, 'schemastery module has no exports');
  assert(typeof z.object === 'function', 'schemastery exports must provide z.object');
  return 'z.object available';
});

for (const relativePath of [
  'lib/index.js',
  'lib/policy.js',
  'lib/route-test.js',
  'lib/typert.contract.js',
  'lib/typert.host.js',
  'lib/typert.remote-client.js',
  'client/client.js',
]) {
  await check(`${relativePath} exists and passes node --check`, () => {
    const fullPath = path.join(ROOT, relativePath);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      throw new Error(`file ${relativePath} does not exist at ${fullPath}`);
    }
    assert(stat.isFile(), `${relativePath} is not a regular file`);
    const result = spawnSync(
      process.execPath,
      ['--check', fullPath],
      { cwd: ROOT, encoding: 'utf8' },
    );
    assert(result.error === undefined, `could not spawn node --check: ${result.error}`);
    assert(
      result.status === 0,
      `node --check failed for ${relativePath}:\n${(result.stderr || result.stdout).trim()}`,
    );
    return 'syntax ok';
  });
}

await check('tests directory contains at least one *.test.ts', () => {
  const testsDir = path.join(ROOT, 'tests');
  let files: string[] = [];
  try {
    files = readdirSync(testsDir);
  } catch (error) {
    throw new Error(`cannot read tests directory: ${error}`);
  }
  const testFiles = files.filter((f) => f.endsWith('.test.ts'));
  assert(
    testFiles.length > 0,
    `tests directory must contain at least one *.test.ts, found: ${files.join(', ') || 'none'}`,
  );
  return `${testFiles.length} test file(s): ${testFiles.join(', ')}`;
});

await check('tests/ and scripts/ contain no lingering *.mjs files', () => {
  for (const dirName of ['tests', 'scripts']) {
    const dirPath = path.join(ROOT, dirName);
    let files: string[] = [];
    try {
      files = readdirSync(dirPath);
    } catch {
      continue;
    }
    const mjsFiles = files.filter((f) => f.endsWith('.mjs'));
    assert(
      mjsFiles.length === 0,
      `${dirName}/ must not contain *.mjs files, found: ${mjsFiles.join(', ')}`,
    );
  }
  return 'no *.mjs found in tests/ or scripts/';
});

await check('installed experimental-auto-review still carries the fixed policy', () => {
  let installed: string | undefined;
  let source: string | undefined;
  for (const candidate of INSTALLED_AUTO_REVIEW_CANDIDATES) {
    source = readInstalledSource(candidate);
    if (source !== undefined) {
      installed = candidate;
      break;
    }
  }
  if (installed === undefined || source === undefined) {
    if (process.env.DSH_INSTALL_DIR !== undefined) {
      throw new Error(
        `DSH_INSTALL_DIR is set, but the installed auto-review source could not be read from ${INSTALLED_AUTO_REVIEW_CANDIDATES.join(', ')}`,
      );
    }
    // A source checkout without any installed DSH package tree cannot perform
    // this integration check. Desktop/npm installations must not skip it.
    return `SKIP (installed package not found in ${INSTALLED_AUTO_REVIEW_CANDIDATES.length} candidate location(s))`;
  }
  const assignment = source.match(/REVIEW_POLICY\s*=\s*`([\s\S]*?)`/);
  assert(assignment, `could not find the REVIEW_POLICY template in ${installed}`);
  assert(
    assignment[1].startsWith(REVIEW_POLICY_PREFIX),
    'installed REVIEW_POLICY no longer starts with the "REVIEW_POLICY\\n" prefix',
  );
  assert(
    assignment[1].includes(REVIEW_POLICY_MARKER),
    'installed REVIEW_POLICY no longer contains the reviewer marker sentence',
  );
  return path.basename(path.dirname(path.dirname(installed)));
});

if (failures.length > 0) {
  console.error(`\n${failures.length} of ${passed + failures.length} checks failed:`);
  for (const failure of failures) console.error(`  - ${failure.label}: ${failure.message}`);
  process.exit(1);
}

console.log(`\nAll ${passed} checks passed.`);
process.exit(0);
