const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "key-bridge-test-"));
let ancestor = root;
while (
  !fs.existsSync(path.join(ancestor, "node_modules/typescript")) &&
  path.dirname(ancestor) !== ancestor
)
  ancestor = path.dirname(ancestor);
const tsRoot = path.join(ancestor, "node_modules");
execFileSync(process.execPath, [
  path.join(tsRoot, "typescript/bin/tsc"),
  "--outDir",
  tmp,
  "--target",
  "ES2022",
  "--module",
  "commonjs",
  "--moduleResolution",
  "node",
  "--strict",
  "--skipLibCheck",
  "--esModuleInterop",
  "--typeRoots",
  path.join(tsRoot, "@types"),
  path.join(root, "src/main/rust-bridge.ts"),
  path.join(root, "src/main/workspaces.ts"),
]);
const mock = path.join(tmp, "host");
fs.writeFileSync(
  mock,
  `#!/usr/bin/env node
let data=Buffer.alloc(0);process.stdin.on('data',part=>{data=Buffer.concat([data,part]);while(data.length>=4){const n=data.readUInt32LE();if(data.length<4+n)return;const h=JSON.parse(data.subarray(4,4+n));if(data.length<4+n+h.binaryLength)return;const binary=data.subarray(4+n,4+n+h.binaryLength);data=data.subarray(4+n+h.binaryLength);if(h.command==='hang')continue;if(h.command==='exit'){process.exit(1)}const out=h.command==='binary'?binary:Buffer.alloc(0);const header=Buffer.from(JSON.stringify({id:h.id,ok:true,result:h.args,binaryLength:out.length}));const pre=Buffer.alloc(4);pre.writeUInt32LE(header.length);const frame=Buffer.concat([pre,header,out]);for(let i=0;i<frame.length;i+=3)process.stdout.write(frame.subarray(i,i+3));}});
`,
  { mode: 0o755 },
);
const { RustHost } = require(path.join(tmp, "rust-bridge.js"));
(async () => {
  const host = new RustHost({ executable: mock, libraryRoot: tmp });
  try {
    assert.deepEqual(await host.invoke("echo", { x: "é" }), { x: "é" });
    assert.deepEqual(
      [
        ...(await host.invoke(
          "binary",
          {},
          { binary: new Uint8Array([0, 255, 3, 9]) },
        )),
      ],
      [0, 255, 3, 9],
    );
    const values = await Promise.all(
      Array.from({ length: 24 }, (_, i) => host.invoke("echo", { i })),
    );
    assert.deepEqual(
      values.map((v) => v.i),
      Array.from({ length: 24 }, (_, i) => i),
    );
    await assert.rejects(
      host.invoke("hang", {}, { timeoutMs: 60 }),
      /timed out/,
    );
    assert.deepEqual(await host.invoke("echo", { restarted: true }), {
      restarted: true,
    });
    await assert.rejects(host.invoke("exit"), /exited/);
    assert.deepEqual(await host.invoke("echo", { again: true }), {
      again: true,
    });
    const busy = Array.from({ length: 64 }, () =>
      host.invoke("hang", {}, { timeoutMs: 1000 }).catch(() => undefined),
    );
    assert.deepEqual(
      await host.invoke("native_cancel_render", { requestId: "x" }),
      { requestId: "x" },
    );
    host.close();
    await Promise.all(busy);
    console.log(
      "Rust bridge: fragmented frames, binary transport, concurrent requests, timeout/exit restart, and cancellation bypass passed",
    );
    if (process.argv[2]) {
      const { Registry } = require(path.join(tmp, "workspaces.js"));
      const options = {
        registryDir: path.join(tmp, "registry"),
        defaultWorkspaceParent: path.join(tmp, "workspaces"),
        hostExecutable: path.resolve(process.argv[2]),
        pdfiumPath: process.argv[3] ? path.resolve(process.argv[3]) : undefined,
      };
      let registry = new Registry(options);
      try {
        const [a] = await registry.list();
        const b = await registry.add(path.join(tmp, "other"), "Other");
        const project = await registry.invoke(
          "workspace_create_project",
          { name: "Research" },
          a.id,
        );
        const note = await registry.invoke(
          "workspace_save_record",
          {
            kind: "note",
            title: "Synapse",
            properties: { reviewed: true },
            body: "Neural memory",
          },
          a.id,
        );
        await registry.invoke(
          "workspace_set_project_membership",
          { projectId: project.id, recordId: note.id, present: true },
          a.id,
        );
        const bytes = Buffer.from("%PDF-contract-test");
        const upload = await registry.invoke(
          "library_import_begin",
          { title: "Paper", length: bytes.length },
          a.id,
        );
        await registry.invoke(
          "library_import_chunk",
          {
            __binary: bytes,
            __headers: { "x-key-import": upload, "x-key-offset": "0" },
          },
          a.id,
        );
        const source = await registry.invoke(
          "library_import_finish",
          { id: upload },
          a.id,
        );
        await registry.invoke(
          "library_update_metadata",
          {
            hash: source.hash,
            title: "Updated",
            authors: ["Alice"],
            year: 2025,
          },
          a.id,
        );
        await registry.invoke(
          "library_set_labels",
          { hash: source.hash, tags: ["review"], collections: ["Methods"] },
          a.id,
        );
        await registry.invoke(
          "library_set_property",
          { hash: source.hash, name: "reviewed", value: true },
          a.id,
        );
        const details = await registry.invoke(
          "library_metadata_details",
          { hash: source.hash },
          a.id,
        );
        assert.equal(details.properties.reviewed, true);
        assert.deepEqual(details.tags, ["review"]);
        await registry.invoke(
          "workspace_set_project_membership",
          {
            projectId: project.id,
            recordId: "source:" + source.hash,
            present: true,
          },
          a.id,
        );
        assert.equal(
          (
            await registry.invoke(
              "workspace_records",
              { projectId: project.id },
              a.id,
            )
          ).length,
          2,
        );
        const sources = await registry.invoke(
          "semantic_library",
          { projectId: project.id },
          a.id,
        );
        assert.equal(sources.length, 1);
        assert.equal(sources[0].title, "Updated");
        assert.equal(
          (
            await registry.invoke(
              "semantic_library",
              { projectId: "missing" },
              a.id,
            )
          ).length,
          0,
        );
        await registry.invoke(
          "library_set_removed",
          { hash: source.hash, removed: true },
          a.id,
        );
        const removed = await registry.invoke("library_removed_documents", {});
        assert.equal(removed.length, 1);
        assert.equal(removed[0].workspaceId, a.id);
        const removedPage = await registry.invoke("semantic_library_page", {
          removed: true,
          limit: 1,
          offset: 0,
        });
        assert.equal(removedPage.total, 1);
        assert.equal(removedPage.documents[0].workspaceId, a.id);
        assert.equal(removedPage.nextOffset, null);
        const officePath = path.join(tmp, "office.docx");
        fs.writeFileSync(officePath, "office test");
        const office = await registry.invoke(
          "workspace_register_file",
          { path: officePath, editor: "word", title: "Office" },
          a.id,
        );
        const officeAgain = await registry.invoke(
          "workspace_register_file",
          { path: officePath, editor: "word", title: "Office" },
          a.id,
        );
        assert.equal(office.id, officeAgain.id);
        assert.equal(office.revision, officeAgain.revision);
        registry.lastUsed.set(b.id, Date.now() - 61_000);
        await registry.retireIdle();
        assert.equal(registry.hosts.has(b.id), false);

        await assert.rejects(
          registry.invoke("workspace_create_project", { name: "Ambiguous" }),
          /Select a workspace/,
        );
        registry.close();
        registry = new Registry(options);
        assert.equal((await registry.list()).length, 2);
        assert.equal(
          (await registry.invoke("workspace_records", {}, a.id)).length,
          2,
        );
        console.log(
          "Real registry: workspace/project persistence, binary imports, metadata/labels/properties, project filtering, and all-workspace removed sources passed",
        );
      } finally {
        registry.close();
      }
    }
  } finally {
    host.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
