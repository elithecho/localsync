// A pushwork repo kept open for the daemon's lifetime.
//
// The pushwork CLI opens the repo, loads every file's document, syncs and
// shuts down on each run: ~13s for a few hundred files. Here the repo is
// opened once; each sync only scans the store folder, writes changed files
// into their documents, waits briefly for the server and writes incoming
// changes back to disk. Incoming changes also arrive as events, so the daemon
// can pull without polling.
//
// This mirrors pushwork 2.2.3's commitWorkdir() using its internal modules
// (loaded by file path; the package only exports its top-level commands).
// The version is pinned in package.json; re-check this file when bumping it.

import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import { dirname, join, sep } from "node:path";

type Bytes = Uint8Array;
type Tree = unknown;
type Handle = {
  url: string;
  doc(): { content: unknown };
  heads(): string[] | undefined;
  change(fn: (d: Record<string, unknown>) => void): void;
  on(ev: "change", fn: () => void): void;
  off(ev: "change", fn: () => void): void;
};
type Repo = { find(url: string): Promise<Handle>; create(doc: unknown): Handle };

export type ResidentOptions = { root: string; pushworkDir: string; onRemoteChange: () => void };

export async function openResident({ root, pushworkDir, onRemoteChange }: ResidentOptions) {
  const req = createRequire(join(pushworkDir, "index.js"));
  const config = req("./config.js");
  const repoMod = req("./repo.js");
  const shapes = req("./shapes/index.js");
  const fsTree = req("./fs-tree.js");
  const ignore = req("./ignore.js");
  const attributes = req("./attributes.js");

  const cfg = await config.readConfig(root);
  const repo: Repo = await repoMod.openRepo(cfg.backend, config.storageDir(root), { offline: false });
  const shape = await shapes.resolveShape(cfg.shape);
  const folder: Handle = await repo.find(cfg.rootUrl);

  const attrs = await attributes.readAttributes(root);
  const isArtifact: (p: string) => boolean = attrs?.hasArtifactRules
    ? (p) => attrs.isArtifact(p)
    : (p) => shapes.isInArtifactDir(p, cfg.artifactDirectories ?? []);

  // ---- change notifications: the folder doc plus every file doc it lists.
  const watched = new Map<string, Handle>();
  const notify = () => onRemoteChange();
  async function subscribe(tree: Tree) {
    const want = new Set<string>();
    for (const [, url] of shapes.flattenLeaves(tree) as Map<string, string>) want.add(shapes.stripHeads(url));
    for (const [url, h] of watched) if (!want.has(url)) (h.off("change", notify), watched.delete(url));
    for (const url of want) {
      if (watched.has(url)) continue;
      const h = await repo.find(url);
      h.on("change", notify);
      watched.set(url, h);
    }
  }
  folder.on("change", notify);

  async function readFileBytes(tree: Tree) {
    const out = new Map<string, { url: string; bytes: Bytes }>();
    for (const [p, url] of shapes.flattenLeaves(tree) as Map<string, string>) {
      const h = await repo.find(url);
      out.set(p, { url, bytes: shapes.contentToBytes(h.doc().content) });
    }
    return out;
  }

  type Files = Map<string, { url: string; bytes: Bytes }>;
  type Snapshot = Map<string, string>; // path -> content hash, as last written to disk
  const hashOf = (b: Bytes) => Bun.hash(b).toString(36);

  // Local changes are disk vs. what we last wrote to disk (`last`), applied
  // on top of the doc's *current* state. Comparing disk with the current doc
  // instead (what the pushwork CLI does) is only safe while nothing else can
  // change the doc: with the repo kept open, a peer's new file reaches the doc
  // before our disk and would read as a local deletion.
  async function applyLocal(disk: Map<string, Bytes>, last: Snapshot | undefined, current: Files) {
    const leaves = new Map([...current].map(([p, f]) => [p, f.url]));
    for (const [p, bytes] of disk) {
      if (last?.get(p) === hashOf(bytes)) continue; // untouched locally
      const cur = current.get(p);
      if (cur && fsTree.byteEq(cur.bytes, bytes)) continue; // already in the doc
      const fresh = shapes.makeFileEntry(p, bytes, isArtifact(p));
      if (cur) {
        shapes.applyFileEntry(await repo.find(shapes.stripHeads(cur.url)), fresh); // edit in place: URL stays stable
        leaves.set(p, shapes.stripHeads(cur.url));
      } else leaves.set(p, repo.create(fresh).url);
    }
    // Without a snapshot (first run) we can't tell "deleted here" from "not
    // written here yet", so no deletions are committed.
    for (const [p, was] of last ?? []) {
      if (disk.has(p)) continue;
      const cur = current.get(p);
      // Deleted locally. If a peer changed it meanwhile, their edit wins.
      if (cur && hashOf(cur.bytes) === was) leaves.delete(p);
    }
    const tree = shapes.newDir();
    for (const [p, url] of leaves) {
      const finalUrl = isArtifact(p) ? shapes.pinUrl(await repo.find(shapes.stripHeads(url))) : url;
      shapes.setFileAt(tree, p.split("/").filter(Boolean), finalUrl);
    }
    return tree;
  }

  function sameTree(a: Tree, b: Tree) {
    const av = shapes.flattenLeaves(a) as Map<string, string>;
    const bv = shapes.flattenLeaves(b) as Map<string, string>;
    if (av.size !== bv.size) return false;
    for (const [k, v] of av) if (bv.get(k) !== v) return false;
    return true;
  }

  async function pruneEmptyDirs(rel: string) {
    for (let d = rel; d && d !== "." && d !== sep; d = dirname(d)) {
      try {
        if ((await fs.readdir(join(root, d))).length) return;
        await fs.rmdir(join(root, d));
      } catch {
        return;
      }
    }
  }

  // Write the folder doc's state to disk. Refuses a partial fetch, because
  // anything on disk that isn't in the tree gets deleted.
  async function materialize(tree: Tree) {
    const leaves = shapes.flattenLeaves(tree) as Map<string, string>;
    const desired = new Map<string, Bytes>();
    await Promise.all(
      [...leaves].map(async ([p, url]) => desired.set(p, shapes.contentToBytes((await repo.find(url)).doc().content))),
    );
    if (desired.size !== leaves.size) throw new Error(`fetched ${desired.size} of ${leaves.size} documents; refusing a partial tree`);
    const present: Map<string, Bytes> = await fsTree.walkDir(root, await ignore.loadIgnore(root));
    const changed: string[] = [];
    for (const [p, bytes] of desired) {
      if (fsTree.byteEq(present.get(p), bytes)) continue;
      await fsTree.writeFileAtomic(join(root, ...p.split("/")), bytes);
      changed.push(p);
    }
    for (const p of present.keys()) {
      if (desired.has(p)) continue;
      await fs.unlink(join(root, ...p.split("/"))).catch(() => {});
      await pruneEmptyDirs(dirname(p.split("/").join(sep)));
      changed.push("-" + p);
    }
    return changed;
  }

  let initial = true;
  // What the disk held after our last write, kept across restarts. Taking it
  // from the doc at open would race with changes arriving from the network.
  const snapshotFile = join(config.pushworkDir(root), "localsync-disk.json");
  let last: Snapshot | undefined;
  try {
    last = new Map(Object.entries(JSON.parse(await fs.readFile(snapshotFile, "utf8"))));
  } catch {}

  return {
    // Same contract as `pushwork sync`: commit the store folder, exchange with
    // the server, then make the folder match the merged state.
    async sync({ idleMs = 300, maxMs = 8000 } = {}) {
      const previousTree = await shape.decode({ repo, root: folder });
      const current = await readFileBytes(previousTree);
      const fsFiles: Map<string, Bytes> = await fsTree.walkDir(root, await ignore.loadIgnore(root));
      const tree = await applyLocal(fsFiles, last, current);
      const committed = !sameTree(previousTree, tree);
      if (committed) await shape.encode({ repo, tree, previousRoot: folder, isArtifactDir: isArtifact });
      // pushwork stamps every sync; doing that on every cycle here would make
      // each sync a change and keep peers busy, so stamp only real commits.
      if (committed || initial) folder.change((d) => void (d.lastSyncAt = Date.now()));
      const server = await repoMod.waitForServerSync(repo, folder, cfg.backend, { idleMs, maxMs: initial ? 30000 : maxMs });
      initial = false;
      const finalTree = await shape.decode({ repo, root: folder });
      const written = await materialize(finalTree);
      last = new Map([...(await readFileBytes(finalTree))].map(([p, f]) => [p, hashOf(f.bytes)])); // disk now matches this
      await fs.writeFile(snapshotFile, JSON.stringify(Object.fromEntries(last)));
      await subscribe(finalTree);
      return { committed, written, synced: Boolean(server?.synced) };
    },
    async close() {
      folder.off("change", notify);
      for (const h of watched.values()) h.off("change", notify);
      await repoMod.safeShutdown(repo);
    },
  };
}

export type Resident = Awaited<ReturnType<typeof openResident>>;
