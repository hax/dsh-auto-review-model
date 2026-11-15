/**
 * Packaging tests for `@aghost-prj/dsh-auto-review-model`.
 *
 * Verifies package manifest, Cordis patch specification, build artifacts,
 * and client/host entrypoints to ensure correct packaging and plugin registration.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgPath = fileURLToPath(import.meta.resolve('@aghost-prj/dsh-auto-review-model/package.json'));
const PKG_ROOT = path.dirname(pkgPath);

test('package.json exports and metadata match plugin requirements', () => {
  const pkgPath = path.join(PKG_ROOT, 'package.json');
  assert.ok(fs.existsSync(pkgPath), 'package.json must exist');

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  assert.equal(pkg.name, '@aghost-prj/dsh-auto-review-model');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'lib/index.js');

  const exportsMap = pkg.exports;
  assert.ok(exportsMap && typeof exportsMap === 'object', 'package.json must have exports');
  assert.equal(exportsMap['.'], './lib/index.js');
  assert.equal(exportsMap['./policy'], './lib/policy.js');
  assert.equal(exportsMap['./client'], './client/client.js');
  assert.equal(exportsMap['./cordis.patch.yml'], './cordis.patch.yml');
  assert.equal(exportsMap['./package.json'], './package.json');
});

test('Typert faces are exported for the Loader and the Client mount', () => {
  const pkgPath = path.join(PKG_ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  /** Resolve one conditional export to its runtime target. */
  const target = (entry: unknown): string => {
    if (typeof entry === 'string') return entry;
    const record = entry as Record<string, unknown> | null;
    return record !== null && typeof record === 'object' && typeof record.default === 'string'
      ? record.default
      : '';
  };
  const types = (entry: unknown): string => {
    const record = entry as Record<string, unknown> | null;
    return record !== null && typeof record === 'object' && typeof record.types === 'string'
      ? record.types
      : '';
  };

  // The Loader auto-registers a package that exports ./typert; the Client mounts
  // the contribution published by ./remote. Both must be conditional objects so
  // TypeScript consumers see the generated declarations.
  assert.equal(target(pkg.exports['./typert']), './lib/typert.host.js');
  assert.equal(target(pkg.exports['./remote']), './lib/typert.remote-client.js');
  assert.equal(types(pkg.exports['./typert']), './lib/typert.host.d.ts');
  assert.equal(types(pkg.exports['./remote']), './lib/typert.remote-client.d.ts');

  // Artifacts are hand-written in generated-artifact shape, so no runtime zod
  // or Harness package may be declared for them.
  const dependencies = { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
  assert.ok(!('zod' in dependencies), 'hand-written Typert artifacts must not add a zod dependency');
  for (const name of Object.keys(dependencies)) {
    assert.ok(
      !name.startsWith('@deepseek-ai/dsh-typert') && !name.startsWith('@deepseek-ai/dsh-api-gateway'),
      `the linked plugin must not import ${name} at runtime`,
    );
  }
});

test('the client build embeds the ./remote contribution from the shared contract', () => {
  const buildScriptPath = path.join(PKG_ROOT, 'scripts', 'build-client.cjs');
  assert.ok(fs.existsSync(buildScriptPath), 'scripts/build-client.cjs must exist');

  const buildScript = fs.readFileSync(buildScriptPath, 'utf8');
  assert.match(buildScript, /src[/\\]typert\.contract\.ts/, 'the build script must read the shared contract source');
  assert.match(buildScript, /createRemoteContribution/, 'the embedded contribution must come from the contract factory');
  assert.match(buildScript, /chunk:\s*contract\.REMOTE_CHUNK_FILE/, 'the contribution must register as a package-local chunk');

  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.build, /scripts\/build-client\.cjs/, 'npm run build must run the client assembly step');

  const bundle = fs.readFileSync(path.join(PKG_ROOT, 'client', 'client.js'), 'utf8');
  assert.match(
    bundle,
    /generated-client-remote-prelude/,
    'the browser bundle must start with the generated contract prelude',
  );
  assert.match(bundle, /client-bundle-body/, 'the browser bundle must keep the tsc-emitted body after the prelude');
  assert.match(bundle, /createRemoteContribution/, 'the browser bundle must construct the mounted contribution');
  const preludeIndex = bundle.indexOf('generated-client-remote-prelude');
  const bodyIndex = bundle.indexOf('client-bundle-body');
  assert.ok(preludeIndex >= 0 && bodyIndex > preludeIndex, 'the contract prelude must precede the client body');
  assert.match(bundle, /ctx\.remote\.\$mount|remote\.\$mount/, 'the client body must mount the contribution with $mount');
  assert.match(
    bundle,
    /@aghost-prj\/dsh-auto-review-model\/client\.remote\.js/,
    'the client body must require the embedded ./remote contribution module',
  );
});

test('cordis.patch.yml and dsh.bundle.patch are aligned', () => {
  const pkgPath = path.join(PKG_ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  assert.ok(pkg.dsh?.bundle?.patch, 'dsh.bundle.patch must be defined');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');

  const patchPath = path.join(PKG_ROOT, 'cordis.patch.yml');
  assert.ok(fs.existsSync(patchPath), 'cordis.patch.yml must exist');

  const patchContent = fs.readFileSync(patchPath, 'utf8');
  assert.match(patchContent, /id:\s*['"]?auto-review-model['"]?/);
  assert.match(patchContent, /name:\s*['"]?@aghost-prj\/dsh-auto-review-model['"]?/);
});

test('dsh.client and peerDependencies are cleaned of deprecated client runtime/slots packages', () => {
  const pkgPath = path.join(PKG_ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  assert.equal(pkg.dsh?.client?.platform, 'web');

  const clientInject: string[] = pkg.dsh?.client?.inject ?? [];
  assert.ok(Array.isArray(clientInject), 'dsh.client.inject must be an array');
  assert.ok(
    !clientInject.includes('@deepseek-ai/dsh-client-runtime'),
    'dsh.client.inject must not include @deepseek-ai/dsh-client-runtime',
  );
  assert.ok(
    !clientInject.includes('@deepseek-ai/dsh-client-ui-slots'),
    'dsh.client.inject must not include @deepseek-ai/dsh-client-ui-slots',
  );

  const peerDeps: Record<string, string> = pkg.peerDependencies ?? {};
  assert.ok(
    !('@deepseek-ai/dsh-client-runtime' in peerDeps),
    'peerDependencies must not include @deepseek-ai/dsh-client-runtime',
  );
  assert.ok(
    !('@deepseek-ai/dsh-client-ui-slots' in peerDeps),
    'peerDependencies must not include @deepseek-ai/dsh-client-ui-slots',
  );
});

test('build artifacts client/client.js and lib/ exist with expected registration', () => {
  const clientPath = path.join(PKG_ROOT, 'client', 'client.js');
  const libIndexPath = path.join(PKG_ROOT, 'lib', 'index.js');
  const libPolicyPath = path.join(PKG_ROOT, 'lib', 'policy.js');

  assert.ok(fs.existsSync(clientPath), 'client/client.js must exist');
  assert.ok(fs.existsSync(libIndexPath), 'lib/index.js must exist');
  assert.ok(fs.existsSync(libPolicyPath), 'lib/policy.js must exist');

  const clientContent = fs.readFileSync(clientPath, 'utf8');
  assert.match(
    clientContent,
    /window\.__ModuleLoader__\.load/,
    'client/client.js must call window.__ModuleLoader__.load',
  );
  assert.match(
    clientContent,
    /id:\s*['"]@aghost-prj\/dsh-auto-review-model['"]/,
    'client/client.js entry id must be @aghost-prj/dsh-auto-review-model',
  );

  for (const artifact of [
    'lib/typert.host.js',
    'lib/typert.host.d.ts',
    'lib/typert.remote-client.js',
    'lib/typert.remote-client.d.ts',
    'lib/typert.contract.js',
  ]) {
    assert.ok(fs.existsSync(path.join(PKG_ROOT, artifact)), `${artifact} must exist in the build output`);
  }
});

test('published ./typert manifest registers no parser-only named schema', async () => {
  // Regression for the Typert Registry boundary: `ctx.typert.toJSONSchema()`
  // resolves a registered named schema and calls `z.toJSONSchema(schema)`,
  // which requires a real Zod schema. This dependency-free package ships a
  // parser-only codec, so the manifest must contribute no named schema; the
  // strict result codec stays on the invocation descriptor instead.
  const module = await import('@aghost-prj/dsh-auto-review-model/typert') as unknown as {
    TYPERT: {
      package: string;
      face: string;
      schemas: unknown[];
      invocations: Array<{ id: string; service?: string; result?: { mode?: string; typeSymbol?: string } }>;
    };
  };
  assert.equal(module.TYPERT.package, '@aghost-prj/dsh-auto-review-model');
  assert.equal(module.TYPERT.face, 'host');
  assert.deepEqual(
    module.TYPERT.schemas,
    [],
    'the Host manifest must not register a parser-only object as a named Zod schema',
  );
  assert.equal(module.TYPERT.invocations.length, 1, 'the single Remote invocation must remain declared');
  const invocation = module.TYPERT.invocations[0];
  assert.equal(invocation.service, 'autoReviewModel');
  assert.equal(invocation.result?.mode, 'strict', 'the strict result codec must stay on the invocation');
  assert.equal(
    invocation.result?.typeSymbol,
    '@aghost-prj/dsh-auto-review-model#ReviewRouteTestResult',
    'the invocation result codec keeps its stable type symbol',
  );

  // Both production wire boundaries must run the strict parser: the Host
  // Gateway calls encode before framing, the Client Gateway calls decode after
  // reconstruction. Neither may pass an unvalidated object through.
  const codec = invocation.result as {
    encode?: (value: unknown) => unknown;
    decode?: (value: unknown) => unknown;
  };
  assert.equal(typeof codec.encode, 'function', 'the published codec must expose the Host encode boundary');
  assert.equal(typeof codec.decode, 'function', 'the published codec must expose the Client decode boundary');
  const valid = {
    status: 'ok',
    code: 'OK',
    route: { provider: 'provider-a', model: 'model-a', reasoningEffort: '' },
    authKind: 'api-key',
    providerName: 'Provider A',
    settingsNs: 'provider-a',
    credentialEnv: [],
    effortUsed: '',
    effortNotAdvertised: false,
    latencyMs: 1,
    retryAfterMs: 0,
    failureCode: '',
    detail: '',
  };
  assert.equal((codec.encode?.(valid) as { code?: string }).code, 'OK');
  assert.equal((codec.decode?.(valid) as { code?: string }).code, 'OK');
  assert.throws(
    () => codec.encode?.({ ...valid, prose: 'model output' }),
    TypeError,
    'the Host encode boundary must reject an undeclared prose field',
  );
  assert.throws(
    () => codec.decode?.({ ...valid, prose: 'model output' }),
    TypeError,
    'the Client decode boundary must reject an undeclared prose field',
  );
});
