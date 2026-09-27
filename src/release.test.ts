import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parse } from "yaml";
import {
  assertChecksum,
  assertPackageIdentity,
  assertUnpublished,
  parseTarballInput,
  preparePublication,
  publicationNeeded,
  selectTarball,
  sha256,
  validateReleaseContext,
  verifyArchive,
  verifyPublished,
} from "../scripts/release.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const identity = { name: "issue-graph", version: "0.2.0" };
const commit = "a".repeat(40);
const context = {
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "vercel-labs/issue-graph",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: commit,
  EXPECTED_SHA: commit,
  EXPECTED_VERSION: identity.version,
};
const owned: string[] = [];

function temporary(): string {
  const dir = mkdtempSync(join(tmpdir(), "issue-graph-release-test-"));
  owned.push(dir);
  return dir;
}

function archive(overrides: Record<string, unknown> = {}): string {
  const dir = temporary();
  const source = join(dir, "source");
  mkdirSync(join(source, "package"), { recursive: true });
  writeFileSync(
    join(source, "package/package.json"),
    JSON.stringify({
      ...identity,
      publishConfig: { access: "public" },
      repository: { url: "git+https://github.com/vercel-labs/issue-graph.git" },
      ...overrides,
    }),
  );
  const tarball = join(dir, "issue-graph-0.2.0.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", source, "package/package.json"]);
  return tarball;
}

afterEach(() => {
  for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("release context", () => {
  test("accepts only the approved canonical main commit and exact version", () => {
    expect(validateReleaseContext(context, identity)).toEqual({ ...identity, commit });
  });

  test("resolves the version from the manifest on main pushes", () => {
    expect(
      validateReleaseContext(
        { ...context, GITHUB_EVENT_NAME: "push", EXPECTED_VERSION: "" },
        identity,
      ),
    ).toEqual({ ...identity, commit });
  });

  test.each([
    ["GITHUB_EVENT_NAME", "pull_request"],
    ["GITHUB_EVENT_NAME", "pull_request_target"],
    ["GITHUB_EVENT_NAME", "workflow_run"],
    ["GITHUB_REPOSITORY", "fork/issue-graph"],
    ["GITHUB_REF", "refs/heads/feature"],
    ["GITHUB_REF", "refs/tags/v0.2.0"],
    ["EXPECTED_SHA", "abc123"],
    ["EXPECTED_SHA", `${commit}\n`],
    ["GITHUB_SHA", "b".repeat(40)],
    ["EXPECTED_VERSION", "0.2.1"],
    ["EXPECTED_VERSION", "v0.2.0"],
    ["EXPECTED_VERSION", ""],
    ["EXPECTED_VERSION", "0.2.0\n"],
    ["EXPECTED_VERSION", "0.2.0; echo unsafe"],
  ])("rejects %s=%s", (key, value) => {
    expect(() => validateReleaseContext({ ...context, [key]: value }, identity)).toThrow();
  });

  test.each([
    { GITHUB_REPOSITORY: "fork/issue-graph" },
    { GITHUB_REF: "refs/heads/feature" },
    { GITHUB_REF: "refs/tags/v0.2.0" },
    { GITHUB_SHA: "b".repeat(40) },
    { EXPECTED_VERSION: "0.2.1" },
  ])("rejects invalid automatic release context %j", (override) => {
    expect(() =>
      validateReleaseContext({ ...context, GITHUB_EVENT_NAME: "push", ...override }, identity),
    ).toThrow();
  });

  test("rejects the previous scoped package name", () => {
    expect(() =>
      validateReleaseContext(context, { ...identity, name: "@vercel-labs/issue-graph" }),
    ).toThrow(/name mismatch/);
  });
});

describe("fail-closed registry check", () => {
  test("allows an absent exact version only with a valid existing package history", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          name: "issue-graph",
          versions: { "0.1.0": {} },
          "dist-tags": { latest: "0.1.0" },
        }),
      ),
    );
    await assertUnpublished(identity, request);
    expect(request).toHaveBeenCalledWith(
      "https://registry.npmjs.org/issue-graph",
      expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }),
    );
  });

  test("rejects an existing exact version even when it is not latest", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          name: "issue-graph",
          versions: { "0.2.0": identity, "0.3.0": {} },
          "dist-tags": { latest: "0.3.0" },
        }),
      ),
    );
    await expect(assertUnpublished(identity, request)).rejects.toThrow(/already exists/);
  });

  test.each([401, 403, 404, 429, 500, 503])("rejects HTTP %s", async (status) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("registry failure", { status }));
    await expect(assertUnpublished(identity, request)).rejects.toThrow(/registry lookup failed/);
  });

  test.each([
    "not json",
    "{}",
    '{"name":"other","versions":{"0.1.0":{}}}',
    '{"name":"issue-graph","versions":[]}',
    '{"name":"issue-graph","versions":{}}',
  ])("rejects malformed registry data: %s", async (body) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    await expect(assertUnpublished(identity, request)).rejects.toThrow();
  });

  test.each([
    "0.2.0",
    "0.2.1",
    "0.10.0",
    "1.0.0",
    "9007199254740993.0.0",
  ])("rejects latest %s when the target is not newer, even without an exact-version entry", async (latest) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          name: "issue-graph",
          versions: { "0.1.0": {} },
          "dist-tags": { latest },
        }),
      ),
    );
    await expect(assertUnpublished(identity, request)).rejects.toThrow(
      /must be newer than registry latest/,
    );
  });

  test.each([
    ["0.10.0", "0.9.0"],
    ["1.0.0", "0.99.99"],
    ["0.2.1", "0.2.0"],
    ["9007199254740993.0.0", "9007199254740992.0.0"],
  ])("compares stable versions numerically: %s > %s", async (version, latest) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          name: "issue-graph",
          versions: { [latest]: {} },
          "dist-tags": { latest },
        }),
      ),
    );
    await expect(assertUnpublished({ ...identity, version }, request)).resolves.toBeUndefined();
  });

  test.each(
    [
      undefined,
      null,
      [],
      "0.1.0",
      {},
      { latest: null },
      { latest: 1 },
      { latest: ["0.1.0"] },
      { latest: "v0.1.0" },
      { latest: "0.1" },
      { latest: "01.1.0" },
      { latest: "0.1.0-beta.1" },
      { latest: "0.1.0+build" },
      { latest: "0.1.0\n" },
    ].map((tags) => [tags]),
  )("rejects malformed or nonstable dist-tags.latest: %j", async (tags) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          name: "issue-graph",
          versions: { "0.1.0": {} },
          "dist-tags": tags,
        }),
      ),
    );
    await expect(assertUnpublished(identity, request)).rejects.toThrow(/dist-tags/);
  });

  test("rejects a latest tag missing from registry version history", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          name: "issue-graph",
          versions: { "0.0.1": {} },
          "dist-tags": { latest: "0.1.0" },
        }),
      ),
    );
    await expect(assertUnpublished(identity, request)).rejects.toThrow(
      /latest is missing from versions/,
    );
  });

  test("propagates network failures rather than treating them as unpublished", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("network unavailable"));
    await expect(assertUnpublished(identity, request)).rejects.toThrow(/network unavailable/);
  });
});

describe("automatic release planning and retry", () => {
  function packument(latest = identity.version) {
    return {
      name: identity.name,
      versions: { [identity.version]: identity, [latest]: { ...identity, version: latest } },
      "dist-tags": { latest },
    };
  }

  test.each(["0.2.0", "0.3.0"])("skips an existing version when latest is %s", async (latest) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(packument(latest))));
    expect(await publicationNeeded(identity, request)).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });

  test("rejects a published version ahead of latest", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(packument("0.1.0"))));
    await expect(publicationNeeded(identity, request)).rejects.toThrow(/ahead of registry latest/);
  });

  test.each([
    { name: "other", version: identity.version },
    { ...identity, version: "0.1.0" },
    null,
  ])("rejects inconsistent published identity %j", async (published) => {
    const metadata = packument();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ...metadata, versions: { [identity.version]: published } })),
      );
    await expect(publicationNeeded(identity, request)).rejects.toThrow();
  });

  test("allows publishing a verified archive only when its version is absent", async () => {
    const tarball = archive();
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          name: identity.name,
          versions: { "0.1.0": {} },
          "dist-tags": { latest: "0.1.0" },
        }),
      ),
    );
    expect(await preparePublication(identity, { tarball, sha256: sha256(tarball) }, request)).toBe(
      true,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  test.each([
    false,
    true,
  ])("retries after npm accepted the archive, changed bytes: %s", async (changed) => {
    const tarball = archive();
    const bytes = readFileSync(tarball);
    const published = Buffer.from(bytes);
    if (changed) published[0] ^= 1;
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(packument())))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...identity,
            dist: {
              integrity: `sha512-${createHash("sha512").update(published).digest("base64")}`,
              tarball: "https://registry.npmjs.org/issue-graph/-/issue-graph-0.2.0.tgz",
            },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array(published)));
    const result = preparePublication(identity, { tarball, sha256: sha256(tarball) }, request);
    if (changed) await expect(result).rejects.toThrow(/SHA-512/);
    else await expect(result).resolves.toBe(false);
    expect(readFileSync(tarball)).toEqual(bytes);
  });
});

describe("read-only published archive verification", () => {
  function fixture() {
    const tarball = archive();
    const bytes = readFileSync(tarball);
    const input = { tarball, sha256: sha256(tarball) };
    const metadata = {
      ...identity,
      dist: {
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        tarball: "https://registry.npmjs.org/issue-graph/-/issue-graph-0.2.0.tgz",
      },
    };
    const wait = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined);
    return { bytes, input, metadata, wait };
  }

  test("checks exact identity, SHA-512 integrity, and downloaded SHA-256 without altering retained bytes", async () => {
    const { bytes, input, metadata, wait } = fixture();
    const modified = statSync(input.tarball).mtimeMs;
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(metadata)))
      .mockResolvedValueOnce(new Response(new Uint8Array(bytes)));
    await verifyPublished(identity, input, request, wait);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "https://registry.npmjs.org/issue-graph/0.2.0",
      metadata.dist.tarball,
    ]);
    for (const [, options] of request.mock.calls) {
      expect(options).toEqual(
        expect.objectContaining({
          method: "GET",
          redirect: "error",
          signal: expect.any(AbortSignal),
        }),
      );
    }
    expect(wait).not.toHaveBeenCalled();
    expect(readFileSync(input.tarball)).toEqual(bytes);
    expect(statSync(input.tarball).mtimeMs).toBe(modified);
  });

  test.each([
    { name: "other-package" },
    { version: "0.1.0" },
    { dist: {} },
  ])("rejects registry identity or missing-integrity mismatch %j without retry", async (override) => {
    const { input, metadata, wait } = fixture();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...metadata, ...override })));
    await expect(verifyPublished(identity, input, request, wait)).rejects.toThrow(
      /mismatch|SHA-512/,
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  test.each([
    null,
    123,
    "sha512-wrong",
    "sha256-wrong",
  ])("rejects dist.integrity %j without downloading or retrying", async (integrity) => {
    const { input, metadata, wait } = fixture();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...metadata, dist: { ...metadata.dist, integrity } })),
      );
    await expect(verifyPublished(identity, input, request, wait)).rejects.toThrow(/SHA-512/);
    expect(request).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  test.each([
    undefined,
    "http://registry.npmjs.org/pkg.tgz",
    "https://example.com/pkg.tgz",
    "https://registry.npmjs.org.evil.example/pkg.tgz",
    "https://registry.npmjs.org@evil.example/pkg.tgz",
    "https://user:password@registry.npmjs.org/pkg.tgz",
    "https://registry.npmjs.org:8443/pkg.tgz",
    "https://registry.npmjs.org/pkg.tgz?token=secret",
    "https://registry.npmjs.org/pkg.tgz#fragment",
    "https://127.0.0.1/pkg.tgz",
    "//registry.npmjs.org/pkg.tgz",
  ])("rejects nonallowlisted or unsafe tarball URL %s before downloading", async (tarball) => {
    const { input, metadata, wait } = fixture();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...metadata, dist: { ...metadata.dist, tarball } })),
      );
    await expect(verifyPublished(identity, input, request, wait)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  test("rejects downloaded bytes differing from the approved artifact without retry", async () => {
    const { bytes, input, metadata, wait } = fixture();
    const changed = new Uint8Array(bytes);
    changed[0] ^= 1;
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(metadata)))
      .mockResolvedValueOnce(new Response(changed));
    await expect(verifyPublished(identity, input, request, wait)).rejects.toThrow(
      /tarball SHA-256/,
    );
    expect(wait).not.toHaveBeenCalled();
    expect(readFileSync(input.tarball)).toEqual(bytes);
  });

  test("bounds downloaded bytes to the approved archive size", async () => {
    const { bytes, input, metadata, wait } = fixture();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(metadata)))
      .mockResolvedValueOnce(new Response(new Uint8Array(bytes.length + 1)));
    await expect(verifyPublished(identity, input, request, wait)).rejects.toThrow(/size limit/);
    expect(wait).not.toHaveBeenCalled();
  });

  test.each([
    "not-json",
    " ".repeat(1024 * 1024 + 1),
  ])("rejects invalid or oversized metadata without retry (case %#)", async (body) => {
    const { input, wait } = fixture();
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(body));
    await expect(verifyPublished(identity, input, request, wait)).rejects.toThrow();
    expect(wait).not.toHaveBeenCalled();
  });

  test.each([400, 401, 403, 302])("does not retry or follow HTTP %s", async (status) => {
    const { input, wait } = fixture();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("failed", { status, headers: { location: "https://example.com/redirect" } }),
      );
    await expect(verifyPublished(identity, input, request, wait)).rejects.toThrow(
      /registry verification failed/,
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  test("rejects a redirected response even if a fetch implementation follows it", async () => {
    const { bytes, input, metadata, wait } = fixture();
    const redirected = new Response(new Uint8Array(bytes));
    Object.defineProperty(redirected, "redirected", { value: true });
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(metadata)))
      .mockResolvedValueOnce(redirected);
    await expect(verifyPublished(identity, input, request, wait)).rejects.toThrow(
      /redirects are forbidden/,
    );
    expect(wait).not.toHaveBeenCalled();
  });

  test("rejects a response from a different URL", async () => {
    const { input, metadata, wait } = fixture();
    const response = new Response(JSON.stringify(metadata));
    Object.defineProperty(response, "url", { value: "https://example.com/metadata" });
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
    await expect(verifyPublished(identity, input, request, wait)).rejects.toThrow(
      /response URL changed/,
    );
    expect(wait).not.toHaveBeenCalled();
  });

  test.each([
    404, 408, 429, 500, 502, 503, 504,
  ])("retries HTTP %s propagation failures with a bounded delay", async (status) => {
    const { bytes, input, metadata, wait } = fixture();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("not ready", { status, headers: { "retry-after": "999999" } }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(metadata)))
      .mockResolvedValueOnce(new Response(new Uint8Array(bytes)));
    await verifyPublished(identity, input, request, wait);
    expect(request).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[1000]]);
  });

  test("retries tarball propagation by rechecking exact metadata and integrity", async () => {
    const { bytes, input, metadata, wait } = fixture();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(metadata)))
      .mockResolvedValueOnce(new Response("not ready", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(metadata)))
      .mockResolvedValueOnce(new Response(new Uint8Array(bytes)));
    await verifyPublished(identity, input, request, wait);
    expect(request).toHaveBeenCalledTimes(4);
    expect(wait.mock.calls).toEqual([[1000]]);
  });

  test("stops after twelve propagation attempts and never changes the retained archive", async () => {
    const { bytes, input, wait } = fixture();
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("not ready", { status: 404 }));
    await expect(verifyPublished(identity, input, request, wait)).rejects.toThrow(
      /after 12 attempts/,
    );
    expect(request).toHaveBeenCalledTimes(12);
    expect(wait.mock.calls).toEqual([
      [1000],
      [2000],
      [4000],
      [8000],
      [16000],
      [30000],
      [30000],
      [30000],
      [30000],
      [30000],
      [30000],
    ]);
    expect(readFileSync(input.tarball)).toEqual(bytes);
  });

  test("allows registry propagation beyond the previous fifteen-second window", async () => {
    const { bytes, input, metadata, wait } = fixture();
    let attempts = 0;
    const request = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).endsWith(".tgz")) return new Response(new Uint8Array(bytes));
      attempts++;
      return attempts <= 8
        ? new Response("processing", { status: 404 })
        : new Response(JSON.stringify(metadata));
    });
    await verifyPublished(identity, input, request, wait);
    expect(attempts).toBe(9);
    expect(wait.mock.calls.reduce((sum, [delay]) => sum + delay, 0)).toBe(121_000);
  });

  test("fails closed on network errors", async () => {
    const { input, wait } = fixture();
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("network unavailable"));
    await expect(verifyPublished(identity, input, request, wait)).rejects.toThrow(
      /network unavailable/,
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  test("rejects an invalid approved digest before any network request", async () => {
    const { input, wait } = fixture();
    const request = vi.fn<typeof fetch>();
    await expect(
      verifyPublished(identity, { ...input, sha256: "0".repeat(64) }, request, wait),
    ).rejects.toThrow(/SHA-256 mismatch/);
    expect(request).not.toHaveBeenCalled();
  });

  test("detects concurrent mutation of the retained archive even when registry bytes match", async () => {
    const { bytes, input, metadata, wait } = fixture();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(metadata)))
      .mockImplementationOnce(async () => {
        writeFileSync(input.tarball, "modified while fetching");
        return new Response(new Uint8Array(bytes));
      });
    await expect(verifyPublished(identity, input, request, wait)).rejects.toThrow(
      /archive changed/,
    );
    expect(wait).not.toHaveBeenCalled();
  });
});

describe("supplied package archive", () => {
  test("uses the supplied archive without ever calling pack or changing its bytes", () => {
    const tarball = archive();
    const before = readFileSync(tarball);
    const modified = statSync(tarball).mtimeMs;
    const digest = sha256(tarball);
    const input = parseTarballInput(["--tarball", tarball, "--sha256", digest]);
    const pack = vi.fn(() => {
      throw new Error("pack/build must not run");
    });
    expect(selectTarball(input, pack)).toEqual({ tarball, sha256: digest });
    verifyArchive(tarball, identity, digest);
    expect(pack).not.toHaveBeenCalled();
    expect(readFileSync(tarball)).toEqual(before);
    expect(statSync(tarball).mtimeMs).toBe(modified);
  });

  test("supplied checksum failures never fall back to packing", () => {
    const tarball = archive();
    const pack = vi.fn(() => tarball);
    expect(() => selectTarball({ tarball, sha256: "0".repeat(64) }, pack)).toThrow(
      /SHA-256 mismatch/,
    );
    expect(pack).not.toHaveBeenCalled();
  });

  test("default mode packs exactly once", () => {
    const tarball = archive();
    const pack = vi.fn(() => tarball);
    expect(selectTarball(parseTarballInput([]), pack)).toEqual({
      tarball,
      sha256: sha256(tarball),
    });
    expect(pack).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["--tarball"],
    ["--tarball", "missing"],
    ["--sha256", "a".repeat(64)],
    ["--tarball", "missing", "--other", "value"],
    ["--tarball", "missing", "--tarball", "duplicate"],
    ["--tarball", "--sha256", "--sha256", "a".repeat(64)],
  ])("rejects malformed arguments %j", (...args) => {
    expect(() => parseTarballInput(args)).toThrow();
  });

  test("resolves relative input and supports either option order", () => {
    const tarball = archive();
    expect(
      parseTarballInput([
        "--sha256",
        sha256(tarball),
        "--tarball",
        relative(process.cwd(), tarball),
      ]),
    ).toEqual({
      tarball: resolve(tarball),
      sha256: sha256(tarball),
    });
  });

  test("rejects a nonexistent file, directory, symlink, or wrong checksum", () => {
    const tarball = archive();
    const dir = temporary();
    const link = join(dir, "link.tgz");
    symlinkSync(tarball, link);
    for (const path of [join(dir, "missing.tgz"), dir, link]) {
      expect(() => parseTarballInput(["--tarball", path, "--sha256", "0".repeat(64)])).toThrow();
    }
    expect(() => parseTarballInput(["--tarball", tarball, "--sha256", "0".repeat(64)])).toThrow(
      /SHA-256 mismatch/,
    );
    expect(() => parseTarballInput(["--tarball", tarball, "--sha256", "invalid"])).toThrow(
      /64 lowercase hex/,
    );
  });

  test.each([
    { name: "other-package" },
    { version: "0.1.0" },
  ])("rejects mismatched archived identity %j", (overrides) => {
    const tarball = archive(overrides);
    expect(() => verifyArchive(tarball, identity, sha256(tarball))).toThrow(/mismatch/);
    expect(() => assertPackageIdentity({ ...identity, ...overrides }, identity)).toThrow(
      /mismatch/,
    );
  });

  test.each([
    { private: true },
    { publishConfig: { access: "public", registry: "https://other.invalid" } },
    { publishConfig: { access: "public", tag: "other" } },
    { publishConfig: { access: "public", provenance: false } },
    { repository: { url: "https://github.com/fork/issue-graph" } },
  ])("rejects archive publication overrides %j", (overrides) => {
    const tarball = archive(overrides);
    expect(() => verifyArchive(tarball, identity, sha256(tarball))).toThrow();
  });

  test("detects archive mutation after selection", () => {
    const tarball = archive();
    const digest = sha256(tarball);
    writeFileSync(tarball, "changed");
    expect(() => assertChecksum(tarball, digest)).toThrow(/archive changed/);
  });

  test("invalid CLI input fails before requiring pnpm or attempting a build", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/verify-package.ts", "--tarball", "missing.tgz"],
      {
        cwd: root,
        env: { ...process.env, npm_execpath: "" },
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage: --tarball PATH --sha256 SHA256");
    expect(result.stdout).not.toContain("pack");
  });
});

describe("retained artifact metadata", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const sourceIdentity = { name: manifest.name, version: manifest.version };
  const filename = `${sourceIdentity.name}-${sourceIdentity.version}.tgz`;

  function recorded() {
    const dir = temporary();
    const tarball = join(dir, filename);
    copyFileSync(archive(sourceIdentity), tarball);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const env = {
      ...process.env,
      ...context,
      GITHUB_SHA: head,
      EXPECTED_SHA: head,
      EXPECTED_VERSION: sourceIdentity.version,
      EXPECTED_TARBALL_SHA256: sha256(tarball),
      GITHUB_OUTPUT: join(temporary(), "outputs"),
    };
    const run = (command: string, overrides: NodeJS.ProcessEnv = {}, imports: string[] = []) =>
      spawnSync(
        process.execPath,
        ["--import", "tsx", ...imports, "scripts/release.ts", command, dir],
        {
          cwd: root,
          env: { ...env, ...overrides },
          encoding: "utf8",
        },
      );
    const result = run("record");
    expect(result.status, result.stderr).toBe(0);
    return { dir, tarball, env, run };
  }

  function registryMock(
    tarball: string,
    state: "absent" | "published" | "changed" | "unavailable",
  ) {
    const bytes = readFileSync(tarball);
    const packument = {
      name: sourceIdentity.name,
      versions: state === "absent" ? { "0.0.1": {} } : { [sourceIdentity.version]: sourceIdentity },
      "dist-tags": { latest: state === "absent" ? "0.0.1" : sourceIdentity.version },
    };
    const metadata = {
      ...sourceIdentity,
      dist: {
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        tarball: `https://registry.npmjs.org/issue-graph/-/${filename}`,
      },
    };
    const mock = join(temporary(), "registry.mjs");
    writeFileSync(
      mock,
      `
      const packument = ${JSON.stringify(packument)};
      const metadata = ${JSON.stringify(metadata)};
      const state = ${JSON.stringify(state)};
      const bytes = Buffer.from(${JSON.stringify(bytes.toString("base64"))}, "base64");
      if (state === "changed") bytes[0] ^= 1;
      globalThis.fetch = async (url) => {
        if (state === "unavailable") return new Response("unavailable", { status: 503 });
        if (url === "https://registry.npmjs.org/issue-graph") return Response.json(packument);
        if (url === "https://registry.npmjs.org/issue-graph/" + metadata.version) return Response.json(metadata);
        if (url === metadata.dist.tarball) return new Response(bytes);
        throw new Error("unexpected registry URL: " + url);
      };
    `,
    );
    return ["--import", mock];
  }

  test.each([
    "absent",
    "published",
    "unavailable",
  ] as const)("plans a real push process against a %s registry", (state) => {
    const { tarball, env, run } = recorded();
    writeFileSync(env.GITHUB_OUTPUT, "");
    const result = run(
      "plan",
      { GITHUB_EVENT_NAME: "push", EXPECTED_VERSION: "" },
      registryMock(tarball, state),
    );
    expect(result.status, result.stderr).toBe(state === "unavailable" ? 1 : 0);
    expect(readFileSync(env.GITHUB_OUTPUT, "utf8")).toBe(
      state === "unavailable"
        ? ""
        : `needed=${state === "absent"}\nversion=${sourceIdentity.version}\n`,
    );
  });

  test.each([
    "absent",
    "published",
    "changed",
    "unavailable",
  ] as const)("prepares the retained archive through the workflow command: %s", (state) => {
    const { tarball, env, run } = recorded();
    writeFileSync(env.GITHUB_OUTPUT, "");
    const before = readFileSync(tarball);
    const result = run("prepare-publish", {}, registryMock(tarball, state));
    const allowed = state === "absent" || state === "published";
    expect(result.status, result.stderr).toBe(allowed ? 0 : 1);
    expect(readFileSync(env.GITHUB_OUTPUT, "utf8")).toBe(
      allowed ? `publish=${state === "absent"}\n` : "",
    );
    expect(readFileSync(tarball)).toEqual(before);
  });

  test("records source identity and digest, then verifies without changing the archive", () => {
    const { dir, tarball, env, run } = recorded();
    const before = readFileSync(tarball);
    expect(JSON.parse(readFileSync(join(dir, "release.json"), "utf8"))).toEqual({
      ...sourceIdentity,
      commit: env.EXPECTED_SHA,
      filename,
      sha256: env.EXPECTED_TARBALL_SHA256,
    });
    expect(readFileSync(env.GITHUB_OUTPUT, "utf8")).toContain(
      `sha256=${env.EXPECTED_TARBALL_SHA256}`,
    );
    const result = run("verify");
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(tarball)).toEqual(before);
  });

  test.each([
    "name",
    "version",
    "commit",
    "filename",
    "sha256",
  ])("rejects changed %s metadata", (field) => {
    const { dir, run } = recorded();
    const path = join(dir, "release.json");
    const metadata = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...metadata, [field]: "changed" }));
    const result = run("verify");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("artifact metadata mismatch");
  });

  test("rejects a missing trusted digest, edited checksum file, or extra artifact", () => {
    const { dir, run } = recorded();
    expect(run("verify", { EXPECTED_TARBALL_SHA256: "" }).status).toBe(1);
    writeFileSync(join(dir, "SHA256SUMS"), "changed");
    expect(run("verify").status).toBe(1);
    writeFileSync(join(dir, "unexpected.tgz"), "extra");
    const result = run("verify");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unexpected artifact files");
  });
});

describe("automatic release workflow contract", () => {
  const source = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  const workflow = parse(source);

  test("runs on main pushes or explicit dispatch, serially with no default write permission", () => {
    expect(Object.keys(workflow.on)).toEqual(["push", "workflow_dispatch"]);
    expect(workflow.on.push).toEqual({ branches: ["main"] });
    expect(workflow.on.workflow_dispatch.inputs.expected_sha.required).toBe(true);
    expect(workflow.on.workflow_dispatch.inputs.expected_version.required).toBe(true);
    expect(workflow.on.workflow_dispatch.inputs.expected_version).not.toHaveProperty("default");
    expect(workflow.on.workflow_dispatch.inputs.publish).toEqual({
      description: "Publish after verification",
      required: true,
      type: "boolean",
      default: false,
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    expect(workflow.env.EXPECTED_SHA).toBe(`\${{ inputs.expected_sha || github.sha }}`);
  });

  test("skips published versions before building and passes the resolved version to every job", () => {
    expect(workflow.jobs.plan.steps.find((step: { id?: string }) => step.id === "plan").run).toBe(
      "node scripts/release.ts plan",
    );
    expect(workflow.jobs.plan.outputs).toEqual({
      needed: `\${{ steps.plan.outputs.needed }}`,
      version: `\${{ steps.plan.outputs.version }}`,
    });
    expect(workflow.jobs.build.needs).toBe("plan");
    expect(workflow.jobs.build.if).toBe("needs.plan.outputs.needed == 'true'");
    expect(workflow.jobs.consumers.needs).toEqual(["plan", "build"]);
    for (const name of ["build", "consumers", "publish", "github-release"]) {
      expect(workflow.jobs[name].env.EXPECTED_VERSION).toBe(`\${{ needs.plan.outputs.version }}`);
    }
  });

  test("publishes only after all consumers in the protected environment", () => {
    expect(workflow.jobs.consumers.strategy.matrix.node).toEqual([20, 22, 24]);
    expect(workflow.jobs.publish.needs).toEqual(["plan", "build", "consumers"]);
    expect(workflow.jobs.publish.environment).toBe("Release");
    expect(workflow.jobs.plan.if).toBe(
      "github.repository == 'vercel-labs/issue-graph' && github.ref == 'refs/heads/main'",
    );
    expect(workflow.jobs.publish.if).toBe(
      "(github.event_name == 'push' || inputs.publish == true) && github.repository == 'vercel-labs/issue-graph' && github.ref == 'refs/heads/main'",
    );
    expect(workflow.jobs.consumers.if).toBeUndefined();
    expect(workflow.jobs["github-release"].needs).toEqual(["plan", "publish"]);
    expect(workflow.jobs["github-release"].if).toBe(workflow.jobs.publish.if);
    for (const job of Object.values(workflow.jobs) as {
      steps: { uses?: string; with?: Record<string, unknown> }[];
    }[]) {
      const checkout = job.steps.find((step) => step.uses === "actions/checkout@v7");
      expect(checkout?.with?.ref).toBe(`\${{ github.sha }}`);
      expect(checkout?.with?.["persist-credentials"]).toBe(false);
    }
    for (const [name, job] of Object.entries(workflow.jobs) as [
      string,
      { permissions?: Record<string, string> },
    ][]) {
      expect(job.permissions?.["id-token"]).toBe(name === "publish" ? "write" : undefined);
      if (name === "github-release") expect(job.permissions?.contents).toBe("write");
      else expect(job.permissions?.contents).not.toBe("write");
    }
  });

  test.each([
    "missing",
    "matching",
    "already-released",
    "mismatched",
    "lookup-error",
  ])("checks the tag commit before creating a release: %s", (scenario) => {
    const script = workflow.jobs["github-release"].steps.find((step: { run?: string }) =>
      step.run?.includes("gh release create"),
    ).run;
    const mock = `
        gh() {
          case "$1 $2" in
            "api --paginate")
              [ "$SCENARIO" != lookup-error ] || return 1
              [ "$SCENARIO" = missing ] || echo "refs/tags/v$EXPECTED_VERSION"
              return 0 ;;
            "api --method")
              [ "$*" = "api --method POST repos/$GITHUB_REPOSITORY/git/refs -f ref=refs/tags/v$EXPECTED_VERSION -f sha=$EXPECTED_SHA" ] ;;
            "api repos/$GITHUB_REPOSITORY/commits/refs/tags/v$EXPECTED_VERSION")
              if [ "$SCENARIO" = mismatched ]; then echo wrong-commit; else echo "$EXPECTED_SHA"; fi ;;
            "release view") [ "$SCENARIO" = already-released ] ;;
            "release create")
              case "$*" in *--verify-tag*) echo RELEASE_CREATED ;; *) return 1 ;; esac ;;
            *) return 1 ;;
          esac
        }
      `;
    const result = spawnSync("bash", ["-e", "-c", `${mock}\n${script}`], {
      env: { ...process.env, ...context, SCENARIO: scenario, RUNNER_TEMP: temporary() },
      encoding: "utf8",
    });
    const allowed = scenario === "missing" || scenario === "matching";
    expect(result.status).toBe(allowed || scenario === "already-released" ? 0 : 1);
    expect(result.stdout.includes("RELEASE_CREATED")).toBe(allowed);
  });

  test("rechecks retained bytes before retry and never republishes an existing archive", () => {
    const steps = workflow.jobs.publish.steps;
    const preflight = steps.findIndex((step: { id?: string }) => step.id === "preflight");
    const publish = steps.findIndex((step: { run?: string }) => step.run?.includes("npm publish"));
    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(publish).toBeGreaterThan(preflight);
    expect(steps[preflight].run).toBe(
      'node scripts/release.ts prepare-publish "$RUNNER_TEMP/release"',
    );
    expect(steps[publish].if).toBe("steps.preflight.outputs.publish == 'true'");
  });

  test("downloads the same immutable artifact ID for testing and publishing", () => {
    for (const name of ["consumers", "publish"]) {
      const download = workflow.jobs[name].steps.find(
        (step: { uses?: string }) => step.uses === "actions/download-artifact@v4",
      );
      expect(download.with["artifact-ids"]).toBe(`\${{ needs.build.outputs.artifact-id }}`);
      expect(workflow.jobs[name].env.EXPECTED_TARBALL_SHA256).toBe(
        `\${{ needs.build.outputs.sha256 }}`,
      );
    }
    const upload = workflow.jobs.build.steps.find(
      (step: { uses?: string }) => step.uses === "actions/upload-artifact@v4",
    );
    expect(upload.with["retention-days"]).toBe(30);
    expect(upload.with.overwrite).toBe(false);
  });

  test("checks registry bytes only after a successful publish and preserves the approved digest", () => {
    const steps = workflow.jobs.publish.steps;
    const published = steps.findIndex((step: { run?: string }) =>
      step.run?.includes("npm publish"),
    );
    const verified = steps.findIndex((step: { run?: string }) =>
      step.run?.includes("verify-published"),
    );
    expect(published).toBeGreaterThanOrEqual(0);
    expect(verified).toBeGreaterThan(published);
    expect(steps[verified].run).toBe(
      'node scripts/release.ts verify-published "$RUNNER_TEMP/release"',
    );
    expect(steps[verified].if).toBeUndefined();
    expect(steps[verified]["continue-on-error"]).toBeUndefined();
    expect(workflow.jobs.publish.env.EXPECTED_TARBALL_SHA256).toBe(
      `\${{ needs.build.outputs.sha256 }}`,
    );
  });

  test("packs once and never rebuilds, executes hooks, or forces provenance during publish", () => {
    expect(source.match(/pnpm pack /g)).toHaveLength(1);
    const publishCommands = workflow.jobs.publish.steps
      .map((step: { run?: string }) => step.run ?? "")
      .join("\n");
    expect(publishCommands).toContain(
      'npm publish "./$TARBALL_FILENAME" --ignore-scripts --access public',
    );
    expect(publishCommands).not.toMatch(
      /pnpm|npm (?:install|ci|run)|--provenance|gh release|git tag/,
    );
    expect(source).not.toContain("secrets.");
    const publish = workflow.jobs.publish.steps.find((step: { run?: string }) =>
      step.run?.includes("npm publish"),
    );
    expect(publish.env).toEqual({ NODE_AUTH_TOKEN: "", NPM_TOKEN: "" });
  });
});
