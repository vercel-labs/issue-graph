import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type PackageIdentity = { name: string; version: string };
export type TarballInput = { tarball: string; sha256: string };

export function sha256(path: string): string {
  assert.ok(lstatSync(path).isFile(), "tarball must be a regular file, not a symlink");
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function assertChecksum(path: string, expected: string): void {
  assert.match(expected, /^[a-f0-9]{64}$/, "expected SHA-256 must be 64 lowercase hex characters");
  assert.equal(sha256(path), expected, "tarball SHA-256 mismatch or archive changed");
}

export function parseTarballInput(args: string[]): TarballInput | undefined {
  if (args.length === 0) return undefined;
  assert.equal(args.length, 4, "usage: --tarball PATH --sha256 SHA256");
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(["--tarball", "--sha256"].includes(args[i]), `unknown option: ${args[i]}`);
    assert.ok(!options.has(args[i]), `duplicate option: ${args[i]}`);
    assert.ok(args[i + 1] && !args[i + 1].startsWith("--"), "option requires a value");
    options.set(args[i], args[i + 1]);
  }
  const tarball = resolve(options.get("--tarball") ?? "");
  const digest = options.get("--sha256") ?? "";
  assertChecksum(tarball, digest);
  return { tarball, sha256: digest };
}

export function selectTarball(input: TarballInput | undefined, pack: () => string): TarballInput {
  if (input) {
    assertChecksum(input.tarball, input.sha256);
    return input;
  }
  const tarball = pack();
  return { tarball, sha256: sha256(tarball) };
}

export function assertPackageIdentity(actual: PackageIdentity, expected: PackageIdentity): void {
  assert.equal(actual.name, expected.name, "archive package name mismatch");
  assert.equal(actual.version, expected.version, "archive package version mismatch");
}

export function verifyArchive(path: string, expected: PackageIdentity, digest: string): void {
  assertChecksum(path, digest);
  const entries = execFileSync("tar", ["-tzf", path], { encoding: "utf8" }).trim().split("\n");
  assert.equal(entries.filter((entry) => entry === "package/package.json").length, 1);
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOzf", path, "package/package.json"], { encoding: "utf8" }),
  );
  assertPackageIdentity(manifest, expected);
  assert.equal(manifest.private, undefined, "release package must not be private");
  assert.equal(manifest.publishConfig?.access, "public");
  assert.equal(manifest.publishConfig?.registry, undefined, "registry must come from the workflow");
  assert.equal(manifest.publishConfig?.tag, undefined, "dist-tag must come from the workflow");
  assert.equal(manifest.publishConfig?.provenance, undefined, "provenance must remain automatic");
  assert.equal(manifest.repository?.url, "git+https://github.com/vercel-labs/issue-graph.git");
  assertChecksum(path, digest);
}

export function validateReleaseContext(
  env: NodeJS.ProcessEnv,
  manifest: PackageIdentity,
): { name: string; version: string; commit: string } {
  assert.ok(
    env.GITHUB_EVENT_NAME === "push" || env.GITHUB_EVENT_NAME === "workflow_dispatch",
    "release requires a main push or manual dispatch",
  );
  assert.equal(env.GITHUB_REPOSITORY, "vercel-labs/issue-graph", "release requires canonical repo");
  assert.equal(env.GITHUB_REF, "refs/heads/main", "release requires main");
  assert.match(env.EXPECTED_SHA ?? "", /^[a-f0-9]{40}$/, "expected SHA must be a full commit SHA");
  assert.equal(env.EXPECTED_SHA?.length, 40, "expected SHA must be a full commit SHA");
  assert.equal(env.GITHUB_SHA, env.EXPECTED_SHA, "event SHA differs from expected SHA");
  const version =
    env.GITHUB_EVENT_NAME === "push" && !env.EXPECTED_VERSION
      ? manifest.version
      : env.EXPECTED_VERSION;
  stableVersionParts(version, "expected version");
  assertPackageIdentity(manifest, { name: "issue-graph", version: version as string });
  return { name: manifest.name, version: manifest.version, commit: env.EXPECTED_SHA as string };
}

function stableVersionParts(value: unknown, label: string): bigint[] {
  assert.ok(typeof value === "string", `${label} must be stable semver`);
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  assert.ok(match && match[0] === value, `${label} must be stable semver`);
  return match.slice(1).map((part) => BigInt(part));
}

export async function publicationNeeded(
  identity: PackageIdentity,
  request: typeof fetch = fetch,
): Promise<boolean> {
  const response = await request(
    `https://registry.npmjs.org/${encodeURIComponent(identity.name)}`,
    {
      headers: { accept: "application/json", "cache-control": "no-cache" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    },
  );
  assert.equal(response.status, 200, `registry lookup failed: HTTP ${response.status}`);
  const packument = await response.json();
  assert.equal(packument.name, identity.name, "registry package identity mismatch");
  assert.ok(
    packument.versions &&
      typeof packument.versions === "object" &&
      !Array.isArray(packument.versions),
    "registry response lacks versions",
  );
  assert.ok(Object.keys(packument.versions).length > 0, "registry response has no version history");
  const tags = packument["dist-tags"];
  assert.ok(tags && typeof tags === "object" && !Array.isArray(tags), "registry lacks dist-tags");
  const latest = stableVersionParts(tags.latest, "registry dist-tags.latest");
  const target = stableVersionParts(identity.version, "target version");
  const differing = target.findIndex((part, index) => part !== latest[index]);
  if (Object.hasOwn(packument.versions, identity.version)) {
    assertPackageIdentity(packument.versions[identity.version], identity);
    assert.ok(
      Object.hasOwn(packument.versions, tags.latest),
      "registry latest is missing from versions",
    );
    assert.ok(
      differing === -1 || target[differing] < latest[differing],
      "published version is ahead of registry latest",
    );
    return false;
  }
  assert.ok(
    differing >= 0 && target[differing] > latest[differing],
    `target ${identity.version} must be newer than registry latest ${tags.latest}`,
  );
  assert.ok(
    Object.hasOwn(packument.versions, tags.latest),
    "registry latest is missing from versions",
  );
  return true;
}

export async function assertUnpublished(
  identity: PackageIdentity,
  request: typeof fetch = fetch,
): Promise<void> {
  assert.ok(
    await publicationNeeded(identity, request),
    `${identity.name}@${identity.version} already exists`,
  );
}

class RegistryPropagationError extends Error {}

function registryUrl(value: unknown): string {
  assert.ok(typeof value === "string", "registry URL must be a string");
  const url = new URL(value);
  assert.ok(
    url.protocol === "https:" &&
      url.hostname === "registry.npmjs.org" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    "registry URL must use only https://registry.npmjs.org without credentials, query, or fragment",
  );
  return url.href;
}

async function registryResponse(url: string, request: typeof fetch): Promise<Response> {
  const allowed = registryUrl(url);
  const response = await request(allowed, {
    method: "GET",
    headers: { "cache-control": "no-cache" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.redirected, false, "registry redirects are forbidden");
  if (response.url) assert.equal(response.url, allowed, "registry response URL changed");
  if (response.status !== 200) {
    await response.body?.cancel();
    if ([404, 408, 429, 500, 502, 503, 504].includes(response.status)) {
      throw new RegistryPropagationError(`registry propagation: HTTP ${response.status}`);
    }
    assert.fail(`registry verification failed: HTTP ${response.status}`);
  }
  return response;
}

async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  assert.ok(response.body, "registry response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      assert.ok(size <= limit, "registry response exceeds approved size limit");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function verifyPublished(
  identity: PackageIdentity,
  input: TarballInput,
  request: typeof fetch = fetch,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
): Promise<void> {
  assertChecksum(input.tarball, input.sha256);
  const approved = readFileSync(input.tarball);
  const integrity = `sha512-${createHash("sha512").update(approved).digest("base64")}`;
  const versionUrl = `https://registry.npmjs.org/${encodeURIComponent(identity.name)}/${encodeURIComponent(identity.version)}`;
  try {
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const metadata = JSON.parse(
          (await boundedBody(await registryResponse(versionUrl, request), 1024 * 1024)).toString(
            "utf8",
          ),
        );
        assertPackageIdentity(metadata, identity);
        assert.equal(
          metadata.dist?.integrity,
          integrity,
          "registry dist.integrity does not match approved SHA-512",
        );
        const downloaded = await boundedBody(
          await registryResponse(registryUrl(metadata.dist?.tarball), request),
          approved.length,
        );
        assert.equal(
          createHash("sha256").update(downloaded).digest("hex"),
          input.sha256,
          "registry tarball SHA-256 does not match approved archive",
        );
        return;
      } catch (error) {
        if (!(error instanceof RegistryPropagationError)) throw error;
        if (attempt === 11)
          throw new Error("registry verification did not propagate after 12 attempts", {
            cause: error,
          });
        await wait(Math.min(1000 * 2 ** attempt, 30_000));
      }
    }
  } finally {
    assertChecksum(input.tarball, input.sha256);
  }
}

export async function preparePublication(
  identity: PackageIdentity,
  input: TarballInput,
  request: typeof fetch = fetch,
): Promise<boolean> {
  assertChecksum(input.tarball, input.sha256);
  const needed = await publicationNeeded(identity, request);
  if (!needed) await verifyPublished(identity, input, request);
  return needed;
}

async function main(): Promise<void> {
  const [command, directory] = process.argv.slice(2);
  assert.ok(
    ["plan", "preflight", "record", "verify", "prepare-publish", "verify-published"].includes(
      command,
    ),
    "expected plan, preflight, record, verify, prepare-publish, or verify-published",
  );
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const identity = validateReleaseContext(process.env, manifest);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(head, identity.commit, "checkout does not match approved SHA");
  if (command === "plan") {
    const needed = await publicationNeeded(identity);
    assert.ok(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT is required");
    appendFileSync(process.env.GITHUB_OUTPUT, `needed=${needed}\nversion=${identity.version}\n`);
    console.log(
      needed
        ? `Release pending: ${identity.name}@${identity.version} at ${head}`
        : `Skipping published ${identity.name}@${identity.version}. To recover an incomplete release, rerun failed jobs in its original workflow run.`,
    );
    return;
  }
  if (command === "preflight") {
    await assertUnpublished(identity);
    console.log(`Release preflight passed: ${identity.name}@${identity.version} at ${head}`);
    return;
  }
  assert.ok(directory, "artifact directory is required");
  const filename = `${identity.name}-${identity.version}.tgz`;
  const tarball = join(directory, filename);
  if (command === "record") {
    assert.deepEqual(readdirSync(directory), [filename], "retain exactly one packed tarball");
    const digest = sha256(tarball);
    verifyArchive(tarball, identity, digest);
    writeFileSync(
      join(directory, "release.json"),
      `${JSON.stringify({ ...identity, filename, sha256: digest }, null, 2)}\n`,
    );
    writeFileSync(join(directory, "SHA256SUMS"), `${digest}  ${filename}\n`);
    assert.ok(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT is required");
    appendFileSync(process.env.GITHUB_OUTPUT, `filename=${filename}\nsha256=${digest}\n`);
    console.log(`Retained ${filename}: ${digest}`);
  } else {
    assert.deepEqual(
      readdirSync(directory).sort(),
      ["SHA256SUMS", filename, "release.json"].sort(),
      "unexpected artifact files",
    );
    const digest = process.env.EXPECTED_TARBALL_SHA256 ?? "";
    const metadata = JSON.parse(readFileSync(join(directory, "release.json"), "utf8"));
    assert.deepEqual(
      metadata,
      { ...identity, filename, sha256: digest },
      "artifact metadata mismatch",
    );
    assert.equal(readFileSync(join(directory, "SHA256SUMS"), "utf8"), `${digest}  ${filename}\n`);
    verifyArchive(tarball, identity, digest);
    console.log(`Verified retained ${filename}: ${digest}`);
    if (command === "prepare-publish") {
      const needed = await preparePublication(identity, { tarball, sha256: digest });
      assert.ok(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT is required");
      appendFileSync(process.env.GITHUB_OUTPUT, `publish=${needed}\n`);
      console.log(needed ? "Archive is ready to publish" : "Exact archive is already published");
    }
    if (command === "verify-published") {
      await verifyPublished(identity, { tarball, sha256: digest });
      console.log(
        `Verified published ${identity.name}@${identity.version}: registry SHA-512 and tarball SHA-256 match the approved archive`,
      );
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
