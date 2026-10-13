import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const sha256 = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const snapshotDate = "2026-10-13";
const runtime = [
  {
    name: "collapse-white-space",
    version: "2.1.0",
    repo: "wooorm/collapse-white-space",
    commit: "728911c098ddc70e6500cbdded13899e419c2f1f",
    notice: "collapse-white-space-2.1.0.txt",
  },
  {
    name: "franc",
    version: "6.2.0",
    repo: "wooorm/franc",
    commit: "612ed4fe777a5b16383efad367c57a359feb78ed",
    npmGitHead: "4b17eaccaa256bb57c46d02414925eb272c3b565",
    tag: "6.2.0",
    packagePath: "packages/franc/package.json",
    sourceFiles: ["index.js", "data.js", "expressions.js"],
    notice: "franc-6.2.0.txt",
  },
  {
    name: "iso639-js",
    version: "1.1.3",
    repo: "maikudou/iso639-js",
    commit: "5a161b16bfdf7e4c0ae82840917da286a285f6dd",
    archiveKind: "npm",
    notice: "ISC-standard.txt",
  },
  {
    name: "jsencrypt",
    version: "3.5.4",
    repo: "travist/jsencrypt",
    commit: "a0ae319f4011d90ec7dc15192c0f7be1f3946ee0",
    notice: "jsencrypt-3.5.4.txt",
  },
  {
    name: "katex",
    version: "0.16.25",
    repo: "KaTeX/KaTeX",
    commit: "d2f1084c5ecca7c47295de52728e0c5f565b12ec",
    notice: "katex-0.16.25.txt",
  },
  {
    name: "n-gram",
    version: "2.0.2",
    repo: "words/n-gram",
    commit: "4533b691a4cbd39c58538a89f17d25c5bf6f5aa3",
    notice: "n-gram-2.0.2.txt",
  },
  {
    name: "trigram-utils",
    version: "2.0.1",
    repo: "wooorm/trigram-utils",
    commit: "ea7788294bcaef39c7ae7aa94bf412885e5d6edf",
    notice: "trigram-utils-2.0.1.txt",
  },
  {
    name: "zotero-plugin-toolkit",
    version: "6.0.0",
    repo: "windingwind/zotero-plugin-toolkit",
    commit: "0fbfd0258921044de1854b89d66b27762b10ee0a",
    notice: "zotero-plugin-toolkit-6.0.0.txt",
  },
];

function verifyInstalledVersions() {
  for (const item of runtime) {
    const pkg = JSON.parse(read(`node_modules/${item.name}/package.json`));
    if (pkg.version !== item.version)
      throw new Error(
        `Review required: ${item.name} is ${pkg.version}, expected ${item.version}`,
      );
  }
  const bundlePackages = new Set();
  for (const filename of ["reliabletranslate.js", "customElements.js"]) {
    const bundle = read(`build/addon/chrome/content/scripts/${filename}`);
    for (const match of bundle.matchAll(
      /\/\/ node_modules\/((?:@[^/]+\/)?[^/]+)\//g,
    ))
      bundlePackages.add(match[1]);
  }
  const expected = new Set(runtime.map((item) => item.name));
  for (const name of bundlePackages)
    if (!expected.has(name))
      throw new Error(`New bundled package requires a license review: ${name}`);
  for (const name of expected)
    if (!bundlePackages.has(name))
      throw new Error(`Recorded package absent from build: ${name}`);
}

function verifyFonts() {
  const dir = "addon/chrome/content/styles/fonts";
  const records = fs
    .readdirSync(path.join(root, dir))
    .filter((name) => name.endsWith(".woff2"))
    .sort()
    .map((name) => {
      const assetHash = sha256(fs.readFileSync(path.join(root, dir, name)));
      const npmHash = sha256(
        fs.readFileSync(path.join(root, "node_modules/katex/dist/fonts", name)),
      );
      if (assetHash !== npmHash)
        throw new Error(`Font differs from KaTeX 0.16.25: ${name}`);
      return {
        file: `${dir}/${name}`,
        sha256: assetHash,
        matchesInstalledKaTeX: true,
      };
    });
  if (records.length !== 20)
    throw new Error(
      `Review font inventory: expected 20, found ${records.length}`,
    );
  return records;
}

function legalSection(title, metadata, filename) {
  const text = read(`addon/licenses/${filename}`);
  return `\n${"=".repeat(78)}\n${title}\n${metadata}\nSnapshot file: licenses/${filename}\nSnapshot SHA-256: ${sha256(Buffer.from(text))}\n${"-".repeat(78)}\n${text}\n`;
}

function collectNotices() {
  verifyInstalledVersions();
  verifyFonts();
  const pkg = JSON.parse(read("package.json"));
  const buildOnly = Object.keys(pkg.devDependencies)
    .sort()
    .map((name) => {
      const installed = JSON.parse(read(`node_modules/${name}/package.json`));
      return `${name}@${installed.version} (${installed.license || "license metadata unavailable"})`;
    })
    .join("\n  ");
  let output = `THIRD-PARTY NOTICES FOR RELIABLE TRANSLATE\nPrepared: ${snapshotDate}\n\nScope\n-----\nThese notices cover the eight npm packages present in the generated runtime JS\nbundles, their nested JSEncrypt code, and the twenty redistributed KaTeX fonts.\nThe main modified plugin remains under AGPL-3.0-or-later; see LICENSE.txt and\nNOTICE.txt for upstream attribution. Each original component retains its own\nlicense. The preserved text below is not replaced by the plugin's AGPL notice.\n\nRuntime package inventory\n-------------------------\n${runtime.map((item) => `  ${item.name}@${item.version} - ${item.archiveKind === "npm" ? "https://registry.npmjs.org/" + item.name + "/" + item.version : "https://github.com/" + item.repo + "/tree/" + item.commit}`).join("\n")}\n\nBuild/test dependencies (not runtime code in the reviewed bundles)\n----------------------------------------------------------------\n  ${buildOnly}\nThese development tools and their transitive dependencies are installed from\npackage-lock.json, are not included as node_modules in the release source ZIP,\nand are not covered by this runtime notice inventory. A distribution that also\nships those development packages must preserve their respective notices.\n\nSource availability\n-------------------\nThe release source should include vendor-sources/SOURCE-MANIFEST.json and the\neight upstream source archives identified there. The recorded npm gitHead is\nvalidated against the package version and the upstream repository package.json.\nKaTeX's complete repository includes src/fonts and dockers/fonts; font hashes\nare checked against the exact KaTeX 0.16.25 npm distribution. Do not execute\nthird-party archive contents simply to inspect them.\n\nSpecific provenance limits\n--------------------------\n- iso639-js 1.1.3 declares license: ISC and author: Mikhail Labanov in its\n  original package.json. The upstream npm package and repository do not supply\n  a separate copyright/license file. No year or copyright statement has been\n  invented here. The full standard ISC license text is reproduced, including\n  its unfilled standard copyright placeholders. The author information above\n  is package metadata, not a fabricated copyright header. Its README credits\n  SIL, Wikipedia and other sources for data; that alone is not a complete\n  data-rights provenance record.\n- JSEncrypt supplies the full license texts for its own code, jsrsasign, jsbn\n  and asn1js. Its bundled source has additional year-specific copyright notices\n  reproduced below. SHA-256 version 2.2 additionally identifies a BSD license;\n  that complete text was obtained from Paul Johnston's linked official site.\n- JSEncrypt's jsrsasign notice says it contains YUI code but does not identify\n  the original YUI version. The full BSD text below is preserved from YUI's\n  official license file; the exact inherited YUI version remains unidentified.\n- All twenty KaTeX .woff2 assets match KaTeX 0.16.25 exactly by SHA-256. The\n  separate katex-fonts MIT notice is also retained from its official repository.\n- Upstream plugin images, logos, SVG icons, screenshots and third-party service\n  access permissions are outside this runtime dependency inventory. These\n  notices do not assert endorsement, trademark permission or service access\n  authorization.\n\nOriginal license texts and copyright notices\n===========================================\n`;
  output = output.replace(
    "eight upstream source archives identified there. The recorded npm gitHead is\nvalidated against the package version and the upstream repository package.json.",
    "seven complete upstream repository archives plus the exact iso639-js 1.1.3\nnpm archive identified there. Six repository archives use verified npm gitHead;\nfranc uses its official 6.2.0 tag with matching preferred source files. iso639-js\nuses its integrity-checked official npm archive because its gitHead is unavailable.",
  );
  output = output.replace(
    "- Upstream plugin images",
    "- KaTeX font-generation Makefile preserves MathJax Apache-2.0 copyright\n  notices. Its xbbold.mf preserves the American Mathematical Society\n  copyright and OFL-1.1 notice, including the upstream font modification\n  statement. These specific licenses supplement, rather than disappear under,\n  the KaTeX repository MIT license. Complete Apache-2.0 and OFL-1.1 texts follow.\n  Rebuilding fonts also needs external TeX Live fonts and system build tools\n  listed by the original Dockerfile; those system packages are not bundled.\n- Upstream plugin images",
  );
  for (const item of runtime) {
    const metadata = `Version: ${item.version}\nSource: ${item.archiveKind === "npm" ? "https://registry.npmjs.org/" + item.name + "/" + item.version : "https://github.com/" + item.repo + "/tree/" + item.commit}\nOriginal npm metadata: https://registry.npmjs.org/${item.name}/${item.version}\nLicense text origin: ${item.name === "franc" ? `https://raw.githubusercontent.com/wooorm/franc/6.2.0/license` : item.name === "iso639-js" ? "https://raw.githubusercontent.com/spdx/license-list-data/main/text/ISC.txt (standard full text; upstream declares ISC in package.json)" : `node_modules/${item.name}/${item.name === "jsencrypt" ? "LICENSE.txt" : ["collapse-white-space", "n-gram", "trigram-utils"].includes(item.name) ? "license" : "LICENSE"}`}`;
    output += legalSection(
      `${item.name} ${item.version}`,
      metadata,
      item.notice,
    );
  }
  output += legalSection(
    "JSEncrypt 3.5.4 embedded source copyright/license headers",
    "Origin: exact leading comments in the installed upstream source files.\nThe following header notices supplement, and do not replace, JSEncrypt's full\naggregate LICENSE.txt reproduced above.",
    "jsencrypt-3.5.4-original-source-headers.txt",
  );
  output += legalSection(
    "SHA-256 version 2.2 (embedded in JSEncrypt 3.5.4)",
    "Source header: Version 2.2 Copyright Angel Marin, Paul Johnston 2000 - 2009.\nOther contributors: Greg Holt, Andrew Kepert, Ydnar, Lostinet.\nFull license source: https://pajhome.org.uk/site/legal.html#bsdlicense\nThe BSD section is transcribed from that author's page without HTML formatting.",
    "sha256-2.2-BSD.txt",
  );
  output += legalSection(
    "YUI BSD license (utilities inherited through jsrsasign)",
    "Source: https://raw.githubusercontent.com/yui/yui3/master/LICENSE.md\nThe complete opening BSD license section is preserved verbatim.\nExact YUI version inherited by JSEncrypt is not identified upstream.",
    "yui-3-BSD.txt",
  );
  output += legalSection(
    "KaTeX fonts",
    "Distributed asset version: the twenty .woff2 files of KaTeX 0.16.25.\nComplete regeneration sources: KaTeX repository at d2f1084c5ecca7c47295de52728e0c5f565b12ec, src/fonts and dockers/fonts.\nAdditional font repository notice source:\nhttps://raw.githubusercontent.com/KaTeX/katex-fonts/56e79c93c88c9054b017cc92e496b383e0bf82d7/LICENSE\nThis license snapshot commit is not asserted to be the generating commit of\nthe redistributed font binaries; their exact matching package is KaTeX 0.16.25.",
    "katex-fonts-MIT.txt",
  );
  output += legalSection(
    "KaTeX 0.16.25 font-generation source headers",
    "Origin: original leading lines read from the verified full KaTeX source archive.\nThe Makefile credits MathJax and the MathJax Consortium under Apache-2.0.\nxbbold.mf version 2.2 credits the American Mathematical Society under OFL-1.1\nand retains its upstream katex-fonts modification notice.\nThese notices are preserved with the original source filenames.",
    "katex-0.16.25-font-source-headers.txt",
  );
  output += legalSection(
    "Apache License 2.0 (KaTeX inherited MathJax font-generation sources)",
    "Source: https://www.apache.org/licenses/LICENSE-2.0.txt\nOriginal source copyright: (c) 2013 MathJax Project and The MathJax Consortium.\nThe full unmodified license includes its standard appendix placeholders; those\nplaceholders are not substituted with invented author or copyright information.",
    "Apache-2.0.txt",
  );
  output += legalSection(
    "SIL Open Font License 1.1 (AMS xbbold font-generation input)",
    "Source: https://raw.githubusercontent.com/spdx/license-list-data/main/text/OFL-1.1.txt\nOriginal source copyright: 1995, 2009 American Mathematical Society.\nThe original font copyright and modification header is reproduced above, and\nthe complete OFL-1.1 license terms are reproduced below.",
    "OFL-1.1.txt",
  );
  output = output.replace(
    "Complete regeneration sources: KaTeX repository",
    "Included generation inputs: KaTeX repository",
  );
  const destination = path.join(root, "addon/THIRD_PARTY_NOTICES.txt");
  if (process.argv.includes("--check")) {
    if (fs.readFileSync(destination, "utf8") !== output)
      throw new Error("THIRD_PARTY_NOTICES.txt is out of date");
  } else fs.writeFileSync(destination, output, "utf8");
  console.log(
    `Verified ${runtime.length} bundled packages and 20 font assets; ${output.length} notice characters.`,
  );
}

async function get(url, binary = false) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "ReliableTranslate-source-audit" },
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok)
        throw new Error(`Source request failed (${response.status}): ${url}`);
      return binary
        ? Buffer.from(await response.arrayBuffer())
        : response.json();
    } catch (error) {
      if (attempt !== 0 || !(error instanceof TypeError)) throw error;
      console.log(`Retrying one interrupted read-only source GET: ${url}`);
    }
  }
  throw new Error(`Source request failed: ${url}`);
}

async function downloadSources() {
  verifyInstalledVersions();
  const destination = path.join(root, "vendor-sources");
  fs.mkdirSync(destination, { recursive: true });
  const sources = [];
  for (const item of runtime) {
    const metadataURL = `https://registry.npmjs.org/${item.name}/${item.version}`;
    const metadata = await get(metadataURL);
    if (
      metadata.version !== item.version ||
      metadata.gitHead !== (item.npmGitHead || item.commit)
    )
      throw new Error(`Version/commit drift requires review: ${item.name}`);
    const packagePath = item.packagePath || "package.json";
    const packageURL =
      item.archiveKind === "npm"
        ? metadataURL
        : `https://raw.githubusercontent.com/${item.repo}/${item.commit}/${packagePath}`;
    if (item.tag) {
      const ref = await get(
        `https://api.github.com/repos/${item.repo}/git/ref/tags/${item.tag}`,
      );
      if (ref.object.type !== "commit" || ref.object.sha !== item.commit)
        throw new Error(`Tag mapping requires review: ${item.name}`);
      for (const sourceFile of item.sourceFiles) {
        const remote = await fetch(
          `https://raw.githubusercontent.com/${item.repo}/${item.commit}/packages/${item.name}/${sourceFile}`,
          { signal: AbortSignal.timeout(30000) },
        );
        if (
          !remote.ok ||
          sha256(Buffer.from(await remote.arrayBuffer())) !==
            sha256(
              fs.readFileSync(
                path.join(root, `node_modules/${item.name}/${sourceFile}`),
              ),
            )
        )
          throw new Error(
            `Tag source differs from installed npm version: ${item.name}/${sourceFile}`,
          );
      }
    }
    const sourcePkg = await get(packageURL);
    if (sourcePkg.name !== item.name || sourcePkg.version !== item.version)
      throw new Error(`Official source package version mismatch: ${item.name}`);
    const url =
      item.archiveKind === "npm"
        ? metadata.dist.tarball
        : `https://codeload.github.com/${item.repo}/tar.gz/${item.commit}`;
    const filename =
      item.archiveKind === "npm"
        ? `${item.name}-${item.version}-npm.tgz`
        : `${item.name}-${item.version}-${item.commit.slice(0, 12)}.tar.gz`;
    const bytes = await get(url, true);
    if (item.archiveKind === "npm") {
      const actualIntegrity = `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
      if (actualIntegrity !== metadata.dist.integrity)
        throw new Error(`npm archive integrity mismatch: ${item.name}`);
    }
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b)
      throw new Error(`Not a gzip source archive: ${item.name}`);
    const filePath = path.join(destination, filename);
    if (
      fs.existsSync(filePath) &&
      sha256(fs.readFileSync(filePath)) !== sha256(bytes)
    )
      throw new Error(
        `Existing archive differs; manual review required: ${filename}`,
      );
    fs.writeFileSync(filePath, bytes);
    const preferredSource =
      item.name === "jsencrypt"
        ? "Complete upstream TypeScript src, embedded components, tests and build scripts; npm bin/lib alone are generated output."
        : item.name === "zotero-plugin-toolkit"
          ? "Complete upstream TypeScript source and build configuration; npm dist alone is generated output."
          : item.name === "katex"
            ? "Complete upstream source, src/fonts generation inputs and dockers/fonts build scripts; npm src is present but npm font-generation sources are incomplete."
            : item.name === "iso639-js"
              ? "Original JavaScript, JSON language mappings, imports, generation tools and upstream README/package.json metadata."
              : "Complete upstream repository including native JavaScript preferred source; the npm package also contains that package's native JS source.";
    sources.push({
      package: item.name,
      version: item.version,
      archive: filename,
      sourceURL: url,
      repository: `https://github.com/${item.repo}`,
      commit: item.archiveKind === "npm" ? null : item.commit,
      recordedNpmGitHead: metadata.gitHead,
      tag: item.tag || null,
      commitEvidence: item.tag
        ? `https://api.github.com/repos/${item.repo}/git/ref/tags/${item.tag}`
        : metadataURL,
      checkedSourcePackageURL: packageURL,
      sha256: sha256(bytes),
      bytes: bytes.length,
      npmTarball: metadata.dist.tarball,
      npmIntegrity: metadata.dist.integrity,
      archiveKind: item.archiveKind || "complete-upstream-repository",
      mappingNote: item.tag
        ? "npm gitHead points to a pre-release package.json (6.1.0); official 6.2.0 tag package.json and all three native JS source files match the installed 6.2.0 distribution exactly."
        : item.archiveKind === "npm"
          ? "Recorded npm gitHead is unavailable from upstream GitHub (404). Exact official npm archive was used with registry sha512 integrity verification; it contains preferred native JS, JSON, tools and imports."
          : "Official repository package.json at npm-recorded gitHead matches the exact installed version.",
      contents: preferredSource,
    });
    console.log(
      `Saved ${item.name}@${item.version} (${bytes.length} bytes) from verified ${item.archiveKind === "npm" ? "npm source distribution" : item.tag ? "official version tag" : "npm gitHead"}.`,
    );
  }
  const manifest = {
    prepared: snapshotDate,
    intendedRelease: "0.1.2",
    archivesExecuted: false,
    scope:
      "The eight npm packages detected in the current runtime JS bundles. Seven complete upstream GitHub repositories and one exact official npm native-source distribution. Version mapping verified, with explicit exceptions and no guessed tags.",
    sources,
    fonts: {
      assetPackage: "katex@0.16.25",
      generationInputs:
        "KaTeX src/fonts and dockers/fonts in the pinned complete repository",
      externalSystemBuildDependenciesNotBundled: [
        "TeX Live base and recommended fonts (original Makefile uses Computer Modern and AMS font inputs)",
        "FontForge, mftrace, ttfautohint, GNU build tools",
        "fonttools, brotli, zopfli as specified by the original Dockerfile",
      ],
      specificSourceLicenses: [
        "MathJax font-generation Makefile: Apache-2.0, original 2013 MathJax copyright header retained",
        "xbbold.mf version 2.2: OFL-1.1, Copyright 1995, 2009 American Mathematical Society, upstream modification notice retained",
      ],
      separateFontNoticeSnapshot: "56e79c93c88c9054b017cc92e496b383e0bf82d7",
      separateFontNoticeIsNotClaimedAsBinaryGeneratingCommit: true,
      files: verifyFonts(),
    },
    limitations: [
      "Development-tool dependency archives and their transitive packages are not included; package-lock.json records reproducible installations.",
      "iso639-js originally declares ISC but does not include a separate copyright/license file; no copyright year was invented.",
      "iso639-js README credits SIL, Wikipedia and other sources without a complete data-rights provenance record.",
      "JSEncrypt's notice identifies inherited YUI code without the exact inherited YUI version.",
      "Font regeneration depends on external system TeX fonts and build tools; the archive contains the original generation inputs and instructions, not a self-contained toolchain or a bit-identical regeneration guarantee.",
      "Inherited plugin images, logos and service-provider access permissions are outside this dependency source inventory.",
    ],
  };
  fs.writeFileSync(
    path.join(destination, "SOURCE-MANIFEST.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  console.log(
    "Wrote vendor-sources/SOURCE-MANIFEST.json. Archive contents were not executed.",
  );
}

if (process.argv.includes("--download-sources")) await downloadSources();
collectNotices();
