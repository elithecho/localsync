#!/usr/bin/env bun
// localsync: keep registered folders under ~ in sync between machines over
// Tailscale, using one pushwork repo (~/.localsync/store) as the shared copy.
//
//   machine A: localsync start; localsync add ~/x; localsync repo
//   machine B: localsync repo add <automerge-url> <ws-endpoint>
//              localsync map <name> ~/elsewhere   (only if B keeps it at another path)
//
// Each synced folder has a name. The shared registry maps name -> the path it
// had on the machine that added it; any machine can map a name to its own path.
//
// One cycle = export (files changed under ~ since the last cycle -> store)
// -> pushwork sync (store <-> peers) -> import (files pushwork changed -> ~).
// Cycles run on a debounced file watch and on a poll timer. The host machine
// also runs the Subduction server, bound to its tailnet address only.

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync,
  renameSync, rmdirSync, rmSync, statSync, symlinkSync, watch, writeFileSync, type FSWatcher,
} from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

const HOME = homedir();
const DIR = process.env.LOCALSYNC_DIR ?? join(HOME, ".localsync");
const STORE = join(DIR, "store"); // the pushwork repo
const FILES = join(STORE, "files"); // mirrored files, keyed by folder name
const REGISTRY = join(STORE, "registry"); // "name<TAB>default path" per line; synced
const PATHS = join(DIR, "paths.json"); // this machine's overrides: name -> path relative to ~, or null to skip
const OPS = join(DIR, "registry.ops"); // add/rm/map queued for the daemon (never write the store mid-sync)
const CONFIG = join(DIR, "config.json");
const BASELINE = join(DIR, "baseline.json");
const BACKUP = join(DIR, "backup");
const LOG = join(DIR, "localsync.log");
const PID = join(DIR, "localsync.pid");
const SERVER_DATA = join(DIR, "server");
const SERVER_KEY = join(DIR, "server.key");
const SUBDUCTION = process.env.PUSHWORK_BIN ?? join(HOME, ".local/bin/subduction");
const SUBDUCTION_RELEASE = "v0.22.0-nightly.2026-11-26";
const PORT = Number(process.env.LOCALSYNC_PORT ?? 18081);
const DEBOUNCE_MS = Number(process.env.LOCALSYNC_DEBOUNCE_MS ?? 2000);
const POLL_MS = Number(process.env.LOCALSYNC_POLL_MS ?? 15000);
const PUSHWORK_TIMEOUT_MS = Number(process.env.LOCALSYNC_PUSHWORK_TIMEOUT_MS ?? 120000);
const LABEL = "dev.localsync";
const PLIST = join(HOME, "Library/LaunchAgents", `${LABEL}.plist`);
const SELF = import.meta.path;
const ROOT = dirname(SELF); // the checkout this file lives in
const LINK = ".localsync-link"; // pushwork follows symlinks, so a link is stored as a file holding its target
const TMP = ".localsync-tmp";

type Config = { role: "host"; ip: string; dns: string; endpoint: string } | { role: "peer"; endpoint: string };

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
const tilde = (p: string) => (p === HOME ? "~" : p.startsWith(HOME + "/") ? "~/" + p.slice(HOME.length + 1) : p);
const untilde = (p: string) => (p === "~" ? HOME : p.startsWith("~/") ? join(HOME, p.slice(2)) : p);

function readConfig(): Config | undefined {
  try {
    return JSON.parse(readFileSync(CONFIG, "utf8"));
  } catch {}
}

function writeConfig(c: Config) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(c, null, 2) + "\n");
}

// ---------- registry ----------

type Registry = Map<string, string>; // name -> default path relative to ~
type PathMap = Record<string, string | null>; // name -> local path, null = skip here
type Entry = { name: string; rel: string }; // a folder active on this machine

function readRegistry(): Registry {
  const reg: Registry = new Map();
  if (!existsSync(REGISTRY)) return reg;
  for (const line of readFileSync(REGISTRY, "utf8").split("\n")) {
    const [name, rel] = line.trim().split("\t");
    if (name && rel && !name.startsWith("#")) reg.set(name, rel);
  }
  return reg;
}

function writeRegistry(reg: Registry) {
  writeFileSync(REGISTRY, [...reg].map(([n, r]) => `${n}\t${r}\n`).join(""));
}

function readPaths(): PathMap {
  try {
    return JSON.parse(readFileSync(PATHS, "utf8"));
  } catch {
    return {};
  }
}

function writePaths(m: PathMap) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(PATHS, JSON.stringify(m, null, 2) + "\n");
}

// CLI edits are queued as tab-separated op lines while the daemon runs,
// because pushwork would overwrite a registry file changed mid-sync:
//   + name rel   add      - name   remove
//   m name rel   map here s name   skip here   d name   back to default
function foldOps(reg: Registry, paths: PathMap, file = OPS) {
  const remapped = new Set<string>();
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const [op, name, rel] = line.split("\t");
      if (!name) continue;
      if (op === "+" && rel) reg.set(name, rel);
      else if (op === "-") reg.delete(name), delete paths[name];
      else if (op === "m" && rel) (paths[name] = rel), remapped.add(name);
      else if (op === "s") (paths[name] = null), remapped.add(name);
      else if (op === "d") delete paths[name], remapped.add(name);
    }
  }
  return { reg, paths, remapped };
}

// Registry and local paths as the CLI should see them, queued edits included.
const effective = () => foldOps(readRegistry(), readPaths());

const overlaps = (a: string, b: string) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
const warned = new Set<string>();

// Folders that sync on this machine. Nested folders would copy the same files
// under two names, so a folder overlapping an earlier one is ignored (and
// reported) until it's remapped. Registry order is the same on every machine.
function activeEntries(reg = readRegistry(), paths = readPaths()): Entry[] {
  const out: Entry[] = [];
  for (const [name, def] of reg) {
    const rel = name in paths ? paths[name] : def;
    if (!rel) continue;
    const clash = out.find((e) => overlaps(e.rel, rel));
    if (clash) {
      const msg = `ignoring "${name}": ~/${rel} overlaps "${clash.name}" (~/${clash.rel}); fix with: localsync map ${name} <path>`;
      if (!warned.has(msg)) warned.add(msg), log(msg);
      continue;
    }
    out.push({ name, rel });
  }
  return out;
}

// Daemon side: fold queued edits in between syncs. A folder whose local path
// changed starts over as "fresh" so the new location can't look like a mass
// deletion of the old one.
function applyOps() {
  if (!existsSync(OPS)) return;
  const taking = OPS + ".taking";
  renameSync(OPS, taking); // a concurrent CLI append lands in a fresh OPS file
  const { reg, paths, remapped } = foldOps(readRegistry(), readPaths(), taking);
  writeRegistry(reg);
  writePaths(paths);
  const base = loadBaseline();
  if (base && remapped.size) {
    for (const k of base.keys()) if (remapped.has(nameOf(k))) base.delete(k);
    writeFileSync(BASELINE, JSON.stringify(Object.fromEntries(base)));
  }
  rmSync(taking);
}

// "~/a/b/", "/Users/me/a/b" -> "a/b". Only paths strictly inside ~.
function toRel(input: string): string {
  const abs = resolve(untilde(input));
  const rel = relative(HOME, abs);
  if (!rel || rel.startsWith("..") || rel.startsWith("/")) die(`Only paths inside ${HOME} can be synced: ${input}`);
  return rel;
}

// "Workspace/a440/paperbase/.scratch" -> "paperbase-scratch"
function defaultName(rel: string) {
  return rel.split("/").slice(-2).map((s) => s.replace(/^\.+/, "")).filter(Boolean).join("-").replace(/[^A-Za-z0-9._-]/g, "-") || "folder";
}

const validName = (n: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n);
const nameOf = (key: string) => key.split("/")[0];
const under = (key: string, names: Set<string>) => names.has(nameOf(key));

// ---------- tailnet ----------

function tailnetSelf(): { ip: string; dns: string } | undefined {
  const app = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  const which = spawnSync("sh", ["-c", "command -v tailscale"], { encoding: "utf8" }).stdout.trim();
  const ts = which || (existsSync(app) ? app : undefined);
  if (!ts) return;
  const r = spawnSync(ts, ["status", "--json"], { encoding: "utf8" });
  try {
    const self = JSON.parse(r.stdout).Self;
    const ip = (self.TailscaleIPs as string[]).find((a) => a.includes("."));
    return ip ? { ip, dns: String(self.DNSName).replace(/\.$/, "") } : undefined;
  } catch {}
}

// ---------- subduction server (host only) ----------

async function ensureSubduction() {
  if (!existsSync(SUBDUCTION)) {
    const asset = ({ "darwin:arm64": "macos-aarch64", "linux:x64": "linux-x86_64", "linux:arm64": "linux-aarch64" } as Record<string, string>)[
      `${process.platform}:${process.arch}`
    ];
    if (!asset) die(`No prebuilt subduction for ${process.platform}/${process.arch}.`);
    const url = `https://github.com/inkandswitch/subduction/releases/download/${SUBDUCTION_RELEASE}/subduction-${asset}-0.22.0`;
    log("downloading", url);
    const res = await fetch(url);
    if (!res.ok) die(`Download failed: ${res.status} ${url}`);
    mkdirSync(dirname(SUBDUCTION), { recursive: true });
    await Bun.write(SUBDUCTION, res);
    chmodSync(SUBDUCTION, 0o755);
    spawnSync("xattr", ["-d", "com.apple.quarantine", SUBDUCTION]);
  }
  if (!existsSync(SERVER_KEY)) {
    writeFileSync(SERVER_KEY, Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex") + "\n", { mode: 0o600 });
  }
  mkdirSync(SERVER_DATA, { recursive: true });
}

function portOpen(host: string, port: number) {
  return new Promise<boolean>((res) => {
    const s = connect({ host, port, timeout: 500 }, () => (s.destroy(), res(true)));
    s.on("error", () => res(false)).on("timeout", () => (s.destroy(), res(false)));
  });
}

async function superviseServer(ip: string, dns: string) {
  await ensureSubduction();
  let backoff = 1000;
  const startOne = async () => {
    // Our readiness check is "the port answers", so a stale server (or anything
    // else) on the port would pass it. Say so instead of looking healthy.
    if (await portOpen(ip, PORT)) log(`port ${ip}:${PORT} is already in use by another process; not starting a second server`);
    const child = spawn(
      SUBDUCTION,
      ["server", "--key-file", SERVER_KEY, "--auth", "open", "--socket", `${ip}:${PORT}`, "--data-dir", SERVER_DATA, "--service-name", `${dns}:${PORT}`],
      { stdio: "inherit", env: { ...process.env, NO_COLOR: "1" } },
    );
    const stop = () => child.kill();
    process.once("exit", stop);
    child.on("exit", (code) => {
      process.off("exit", stop);
      log(`subduction exited (${code}); restarting in ${backoff}ms`);
      setTimeout(startOne, backoff);
      backoff = Math.min(backoff * 2, 60000);
    });
    for (let i = 0; i < 40 && !(await portOpen(ip, PORT)); i++) await Bun.sleep(250);
    if (await portOpen(ip, PORT)) {
      backoff = 1000;
      log(`subduction listening on ws://${dns}:${PORT} (bound ${ip})`);
    }
  };
  await startOne();
}

// ---------- file engine ----------

// rel -> "F:<content hash>" or "L:<link target, ~-relative when inside ~>".
type Listing = Map<string, string>;

const skipName = (n: string) => n === ".git" || n === "node_modules" || n === ".DS_Store" || n === ".pushwork" || n.endsWith(".tmp") || n.includes(TMP);

function walk(root: string, rel: string, out: Listing, kind: "home" | "store") {
  const p = rel ? join(root, rel) : root;
  if (rel && skipName(basename(rel))) return;
  const st = lstatSync(p, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isSymbolicLink()) {
    if (kind === "home") out.set(rel, "L:" + tilde(readlinkSync(p)));
    return; // the store never holds real symlinks
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(p)) walk(root, rel ? join(rel, name) : name, out, kind);
  } else if (st.isFile()) {
    if (kind === "store" && rel.endsWith(LINK)) out.set(rel.slice(0, -LINK.length), "L:" + readFileSync(p, "utf8").trim());
    else out.set(rel, "F:" + Bun.hash(readFileSync(p)).toString(36));
  }
}

// Keys are "<name>/<path inside the folder>" (or just "<name>" for a single file).
function listHome(entries: Entry[]): Listing {
  const out: Listing = new Map();
  for (const e of entries) {
    const tmp: Listing = new Map();
    walk(HOME, e.rel, tmp, "home");
    for (const [rel, v] of tmp) out.set(e.name + rel.slice(e.rel.length), v);
  }
  return out;
}

// Key -> path relative to ~ on this machine (entries must contain the key's folder).
let current: Entry[] = [];
function homeRel(key: string) {
  const name = nameOf(key);
  const e = current.find((x) => x.name === name);
  if (!e) throw new Error(`no local path for ${name}`);
  return e.rel + key.slice(name.length);
}

// Everything in the store, or only the given folders.
function listStore(names?: Set<string>): Listing {
  const out: Listing = new Map();
  walk(FILES, "", out, "store");
  if (names) for (const k of out.keys()) if (!under(k, names)) out.delete(k);
  return out;
}

// True when a parent directory of rel under root is a symlink: never write or delete through it.
function throughLink(root: string, rel: string) {
  let p = root;
  const parts = rel.split("/").slice(0, -1);
  for (const part of parts) {
    p = join(p, part);
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (!st) return false;
    if (st.isSymbolicLink()) return true;
  }
  return false;
}

function prune(root: string, from: string) {
  for (let d = dirname(from); d.startsWith(root + "/"); d = dirname(d)) {
    try {
      rmdirSync(d); // stops at the first non-empty directory
    } catch {
      break;
    }
  }
}

function atomicCopy(src: string, dst: string) {
  const data = readFileSync(src);
  // pushwork drops exec bits: keep the existing mode, else take the source's, plus +x for a shebang.
  let mode = (lstatSync(dst, { throwIfNoEntry: false })?.isFile() ? statSync(dst).mode : statSync(src).mode) & 0o777;
  if (data[0] === 0x23 && data[1] === 0x21) mode |= 0o111;
  mkdirSync(dirname(dst), { recursive: true });
  const tmp = `${dst}${TMP}-${process.pid}`;
  writeFileSync(tmp, data, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, dst); // readers never see a half-written file
}

function removePath(p: string) {
  const st = lstatSync(p, { throwIfNoEntry: false });
  if (st) rmSync(p, { recursive: st.isDirectory() && !st.isSymbolicLink(), force: true });
}

function toStore(rel: string, v: string) {
  const dst = join(FILES, rel);
  if (v.startsWith("L:")) {
    removePath(dst);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst + LINK, v.slice(2) + "\n");
  } else {
    removePath(dst + LINK);
    if (lstatSync(dst, { throwIfNoEntry: false })?.isDirectory()) removePath(dst);
    atomicCopy(join(HOME, homeRel(rel)), dst);
  }
}

function dropFromStore(rel: string) {
  for (const p of [join(FILES, rel), join(FILES, rel + LINK)]) {
    removePath(p);
    prune(FILES, p);
  }
}

function toHome(key: string, v: string) {
  const rel = homeRel(key);
  if (throughLink(HOME, rel)) return;
  const dst = join(HOME, rel);
  const cur = lstatSync(dst, { throwIfNoEntry: false });
  if (cur?.isDirectory() && !cur.isSymbolicLink()) removePath(dst);
  if (v.startsWith("L:")) {
    removePath(dst);
    mkdirSync(dirname(dst), { recursive: true });
    symlinkSync(untilde(v.slice(2)), dst);
  } else {
    if (cur?.isSymbolicLink()) removePath(dst);
    atomicCopy(join(FILES, key), dst);
  }
}

function dropFromHome(key: string) {
  const rel = homeRel(key);
  if (throughLink(HOME, rel)) return;
  const p = join(HOME, rel);
  removePath(p);
  prune(HOME, p);
}

let backupStamp = "";
function backup(key: string) {
  const rel = homeRel(key);
  const src = join(HOME, rel);
  if (!lstatSync(src, { throwIfNoEntry: false })) return;
  const dst = join(BACKUP, backupStamp, rel);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { verbatimSymlinks: true, recursive: true });
  log("backed up", tilde(src), "->", tilde(dst));
}

function loadBaseline(): Listing | undefined {
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(BASELINE, "utf8"))));
  } catch {}
}

const summary = (xs: string[]) => `${xs.length}: ${xs.slice(0, 5).join(", ")}${xs.length > 5 ? ", …" : ""}`;

// A folder is "fresh" on this machine when the baseline knows none of its
// files: first run, just added, just remapped. For a fresh folder the store
// wins: only files the store lacks go out, differing local files are backed
// up and replaced, and nothing is deleted.
const baseNames = (base: Listing) => new Set([...base.keys()].map(nameOf));

// ~ -> store: what changed locally since the baseline.
function exportLocal(entries: Entry[], base: Listing): string[] {
  current = entries;
  const names = new Set(entries.map((e) => e.name));
  const known = baseNames(base);
  const local = listHome(entries);
  const store = listStore(names);
  const changed: string[] = [];
  for (const [k, v] of local) {
    const push = known.has(nameOf(k)) ? base.get(k) !== v : !store.has(k);
    if (push) (toStore(k, v), changed.push(k));
  }
  for (const k of base.keys()) if (under(k, names) && !local.has(k)) (dropFromStore(k), changed.push("-" + k));
  return changed;
}

// store -> ~: what pushwork changed, plus anything that differs in a fresh folder.
// A local file holding an unsynced edit is backed up before it's replaced.
function importRemote(entries: Entry[], before: Listing, after: Listing, base: Listing): string[] {
  current = entries;
  const known = baseNames(base);
  const local = listHome(entries);
  const changed: string[] = [];
  backupStamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const [k, v] of after) {
    if (local.get(k) === v) continue;
    if (known.has(nameOf(k)) && before.get(k) === v) continue;
    if (local.has(k) && local.get(k) !== before.get(k)) backup(k);
    toHome(k, v);
    changed.push(k);
  }
  for (const [k, v] of before) {
    if (after.has(k) || !local.has(k)) continue;
    if (local.get(k) !== v) backup(k);
    dropFromHome(k);
    changed.push("-" + k);
  }
  return changed;
}

// pushwork is a pinned dependency of this checkout (package.json), so a clone
// needs `bun install` and nothing global. It runs under this same Bun, so no
// Node.js is needed (its bin script says `#!/usr/bin/env node`). A pushwork
// on PATH is the fallback.
let pushworkCmd: string[] | undefined;
function pushworkBin(): string[] {
  if (pushworkCmd) return pushworkCmd;
  const local = join(ROOT, "node_modules/pushwork/dist/cli.js");
  if (existsSync(local)) return (pushworkCmd = [process.execPath, local]);
  const found = spawnSync("sh", ["-c", "command -v pushwork"], { encoding: "utf8" }).stdout.trim();
  if (found) return (pushworkCmd = [found]);
  return die(`pushwork is not installed. Run \`bun install\` in ${ROOT}.`);
}

function runPushwork(args: string[], cwd = STORE) {
  const [cmd, ...pre] = pushworkBin();
  // Bounded: signals (stop) are only handled between syncs, and an unreachable
  // server must not wedge the daemon.
  return spawnSync(cmd, [...pre, ...args], { cwd, encoding: "utf8", env: process.env, timeout: PUSHWORK_TIMEOUT_MS });
}

function pushworkSync() {
  const r = runPushwork(["--quiet", "sync"]);
  if (r.status !== 0) throw new Error(`pushwork sync failed (${r.status ?? r.error?.message}): ${`${r.stdout ?? ""}${r.stderr ?? ""}`.trim()}`);
}

let busy = false;
let again = false;

async function cycle(reason: string) {
  if (busy) return void (again = true);
  busy = true;
  try {
    mkdirSync(FILES, { recursive: true });
    applyOps();
    const base = loadBaseline() ?? new Map();
    const out = exportLocal(activeEntries(), base);
    // A watch event with nothing new (e.g. our own import) needs no network trip.
    if (reason === "watch" && out.length === 0) return;
    // Snapshot the whole store, then scope it with the registry as it is after
    // the sync, so a folder removed elsewhere is dropped from both sides of
    // the comparison instead of looking like a mass deletion.
    const rawBefore = listStore();
    pushworkSync();
    const entries = activeEntries();
    const names = new Set(entries.map((e) => e.name));
    const before = new Map([...rawBefore].filter(([k]) => under(k, names)));
    const after = listStore(names);
    const inn = importRemote(entries, before, after, base);
    writeFileSync(BASELINE, JSON.stringify(Object.fromEntries(listStore(names))));
    if (out.length) log(`[${reason}] pushed ${summary(out)}`);
    if (inn.length) log(`[${reason}] pulled ${summary(inn)}`);
    rewatch(entries);
  } catch (e) {
    log(`[${reason}]`, (e as Error).message);
  } finally {
    busy = false;
    if (again) {
      again = false;
      queueMicrotask(() => cycle("queued"));
    }
  }
}

// ---------- watching ----------

const watchers = new Map<string, FSWatcher>();
let timer: ReturnType<typeof setTimeout> | undefined;

function onChange() {
  clearTimeout(timer);
  timer = setTimeout(() => cycle("watch"), DEBOUNCE_MS);
}

// One watcher per registered path; a file is watched through its parent so
// atomic rename-writes still fire. exportLocal() decides what really changed.
function rewatch(entries: Entry[]) {
  const want = new Set(entries.map((e) => join(HOME, e.rel)));
  for (const [p, w] of watchers) if (!want.has(p)) (w.close(), watchers.delete(p));
  for (const p of want) {
    if (watchers.has(p) || !existsSync(p)) continue;
    const isDir = statSync(p).isDirectory();
    const only = isDir ? undefined : basename(p);
    try {
      const w = watch(isDir ? p : dirname(p), { recursive: isDir }, (_ev, name) => {
        if (only && name !== only) return;
        if (name && String(name).includes(TMP)) return; // our own temp files
        onChange();
      });
      w.on("error", () => watchers.delete(p));
      watchers.set(p, w);
    } catch (e) {
      log("watch failed", tilde(p), (e as Error).message);
    }
  }
}

// ---------- daemon ----------

async function daemon() {
  const config = readConfig() ?? die("Not set up. Run `localsync start` (first machine) or `localsync repo add <url> <endpoint>`.");
  mkdirSync(DIR, { recursive: true });
  writeFileSync(PID, process.pid + "\n");
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGUSR1", () => cycle("registry")); // sent by add/rm/map
  process.on("exit", () => {
    try {
      if (readFileSync(PID, "utf8").trim() === String(process.pid)) rmSync(PID);
    } catch {}
  });

  process.env.PUSHWORK_SUBDUCTION_SERVER = config.endpoint;
  if (config.role === "host") await superviseServer(config.ip, config.dns);
  if (!existsSync(join(STORE, ".pushwork/config.json"))) die(`No pushwork store at ${STORE}.`);
  log(`localsync ${config.role}: ${config.endpoint}, ${activeEntries().length} folders, debounce ${DEBOUNCE_MS}ms, poll ${POLL_MS}ms`);

  rewatch(activeEntries());
  await cycle("start");
  setInterval(() => cycle("poll"), POLL_MS);
}

// ---------- CLI ----------

function daemonPid(): number | undefined {
  if (!existsSync(PID)) return;
  const pid = Number(readFileSync(PID, "utf8"));
  try {
    process.kill(pid, 0);
    return pid;
  } catch {}
}

const uid = () => process.getuid?.() ?? 0;

function pushwork(args: string[], cwd = STORE) {
  const r = runPushwork(args, cwd);
  if (r.status !== 0) die(`pushwork ${args.join(" ")} failed: ${`${r.stdout ?? ""}${r.stderr ?? ""}`.trim()}`);
  return r.stdout.trim();
}

// First `start` on a machine with no config makes it the host.
function setupHost() {
  const self = tailnetSelf() ?? die("Tailscale is not running here. To join another machine instead, use `localsync repo add <url> <endpoint>`.");
  const endpoint = `ws://${self.dns}:${PORT}`;
  mkdirSync(FILES, { recursive: true });
  if (!existsSync(REGISTRY)) writeRegistry(new Map());
  process.env.PUSHWORK_SUBDUCTION_SERVER = endpoint;
  if (!existsSync(join(STORE, ".pushwork/config.json"))) pushwork(["--quiet", "init"]); // works offline
  writeConfig({ role: "host", ip: self.ip, dns: self.dns, endpoint });
  console.log(`Hosting on ${endpoint} (tailnet only).`);
}

function start() {
  if (!readConfig()) setupHost();
  if (daemonPid()) return console.log(`Already running (pid ${daemonPid()})`);
  const bun = process.execPath;
  if (process.platform === "darwin") {
    // launchd keeps it alive and restarts it at login until `localsync stop`.
    const path = [join(HOME, ".bun/bin"), join(HOME, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
    mkdirSync(dirname(PLIST), { recursive: true });
    writeFileSync(
      PLIST,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${bun}</string><string>${SELF}</string><string>run</string></array>
  <key>WorkingDirectory</key><string>${DIR}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${path}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict></plist>
`,
    );
    spawnSync("launchctl", ["bootout", `gui/${uid()}/${LABEL}`]);
    const r = spawnSync("launchctl", ["bootstrap", `gui/${uid()}`, PLIST], { encoding: "utf8" });
    if (r.status !== 0) die(`launchctl bootstrap failed: ${r.stderr}`);
  } else {
    const fd = openSync(LOG, "a");
    spawn(bun, [SELF, "run"], { cwd: DIR, detached: true, stdio: ["ignore", fd, fd] }).unref();
  }
  console.log(`Started. Logs: ${LOG}`);
}

async function stop() {
  if (process.platform === "darwin" && existsSync(PLIST)) {
    spawnSync("launchctl", ["bootout", `gui/${uid()}/${LABEL}`]);
    rmSync(PLIST);
  }
  const pid = daemonPid();
  if (pid) {
    try {
      process.kill(pid);
    } catch {}
    for (let i = 0; i < 20 && daemonPid(); i++) await Bun.sleep(250);
  }
  console.log(pid ? `Stopped (pid ${pid})` : "Not running");
}

// Daemon running: queue the edit and wake it. Otherwise apply it right away.
function edit(...fields: string[]) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(OPS, fields.join("\t") + "\n", { flag: "a" });
  const pid = daemonPid();
  if (pid) process.kill(pid, "SIGUSR1");
  else if (existsSync(join(STORE, ".pushwork/config.json"))) applyOps();
}

function requireStore() {
  if (!existsSync(join(STORE, ".pushwork/config.json"))) die("Not set up. Run `localsync start` or `localsync repo add <url> <endpoint>` first.");
}

// Local folders other than `except`, to refuse nested or overlapping paths.
function overlap(rel: string, except?: string) {
  const { reg, paths } = effective();
  return activeEntries(reg, paths).find((e) => e.name !== except && overlaps(e.rel, rel));
}

function add(input: string, as?: string) {
  requireStore();
  const rel = toRel(input);
  if (!lstatSync(join(HOME, rel), { throwIfNoEntry: false })) die(`Not found: ${input}`);
  const name = as ?? defaultName(rel);
  if (!validName(name)) die(`Bad name "${name}": use letters, digits, ".", "_" or "-".`);
  const { reg } = effective();
  if (reg.has(name)) die(`"${name}" is already synced. Pick another name with --as, or point it here with: localsync map ${name} ${tilde(join(HOME, rel))}`);
  const clash = overlap(rel);
  if (clash) die(`~/${rel} overlaps "${clash.name}" (~/${clash.rel}).`);
  edit("+", name, rel);
  console.log(`Syncing ~/${rel} as "${name}"`);
}

// A name, or a local path that some folder is mapped to.
function resolveName(input: string) {
  const { reg, paths } = effective();
  if (reg.has(input)) return input;
  const rel = toRel(input);
  return activeEntries(reg, paths).find((e) => e.rel === rel)?.name ?? die(`Not synced: ${input}`);
}

function rm(input: string) {
  requireStore();
  const name = resolveName(input);
  edit("-", name);
  console.log(`Stopped syncing "${name}" (files stay on every machine)`);
}

function map(name?: string, target?: string) {
  requireStore();
  if (!name || !target) return die("usage: localsync map <name> <path> | --skip | --default");
  const { reg } = effective();
  if (!reg.has(name)) die(`No synced folder named "${name}". See \`localsync ls\`.`);
  if (target === "--skip") return edit("s", name), console.log(`"${name}" won't sync on this machine`);
  const rel = target === "--default" ? reg.get(name)! : toRel(target);
  const clash = overlap(rel, name);
  if (clash) die(`~/${rel} overlaps "${clash.name}" (~/${clash.rel}).`);
  if (target === "--default") edit("d", name);
  else edit("m", name, rel);
  console.log(`"${name}" syncs to ~/${rel} on this machine`);
}

function repoAdd(url?: string, endpoint?: string) {
  if (!url?.startsWith("automerge:") || !endpoint?.startsWith("ws")) return die("usage: localsync repo add <automerge:...> <ws://host:port>");
  if (readConfig()) die(`Already set up (${CONFIG}). Remove ${DIR} to start over.`);
  if (existsSync(STORE) && readdirSync(STORE).length) die(`${STORE} is not empty.`);
  process.env.PUSHWORK_SUBDUCTION_SERVER = endpoint;
  mkdirSync(DIR, { recursive: true });
  console.log("Cloning…");
  pushwork(["--quiet", "clone", url, STORE], DIR);
  writeConfig({ role: "peer", endpoint });
  console.log(`Joined. Folders: ${[...readRegistry()].map(([n, r]) => `${n} (~/${r})`).join(", ") || "(none yet)"}`);
  console.log("If one lives elsewhere on this machine: localsync map <name> <path>");
  start();
}

const [cmd = "help", ...args] = process.argv.slice(2);
switch (cmd) {
  case "start":
    start();
    break;
  case "stop":
    await stop();
    break;
  case "restart":
    await stop();
    start();
    break;
  case "status": {
    const c = readConfig();
    const pid = daemonPid();
    console.log(pid ? `Running (pid ${pid})` : "Not running");
    console.log(`Role     ${c?.role ?? "(not set up)"}`);
    console.log(`Endpoint ${c?.endpoint ?? "-"}`);
    console.log(`Folders  ${activeEntries().length} syncing here, ${readRegistry().size} total`);
    console.log(`Log      ${LOG}`);
    break;
  }
  case "logs":
    spawn("tail", ["-n", "50", "-f", LOG], { stdio: "inherit" });
    break;
  case "run":
    await daemon();
    break;
  case "add": {
    const i = args.indexOf("--as");
    const as = i >= 0 ? args.splice(i, 2)[1] : undefined;
    if (!args.length || (i >= 0 && !as)) die("usage: localsync add <path>... | localsync add <path> --as <name>");
    if (as && args.length > 1) die("--as names one folder; add the others separately.");
    for (const a of args) add(a, as);
    break;
  }
  case "rm":
    if (!args.length) die("usage: localsync rm <name|path>...");
    for (const a of args) rm(a);
    break;
  case "map":
    map(args[0], args[1]);
    break;
  case "ls": {
    const { reg, paths } = effective();
    const active = new Set(activeEntries(reg, paths).map((e) => e.name));
    for (const [name, def] of reg) {
      const rel = name in paths ? paths[name] : def;
      const how = rel === null ? "skipped here" : !active.has(name) ? "IGNORED: overlaps another folder" : name in paths ? "mapped here" : "";
      const missing = rel && !existsSync(join(HOME, rel)) ? "not here yet" : "";
      console.log([name.padEnd(24), rel ? `~/${rel}` : "-", [how, missing].filter(Boolean).join(", ")].join("  ").trimEnd());
    }
    break;
  }
  case "repo":
    if (args[0] === "add") repoAdd(args[1], args[2]);
    else {
      requireStore();
      const c = readConfig()!;
      console.log(`On the other machine run:\n  localsync repo add ${pushwork(["url"])} ${c.endpoint}`);
    }
    break;
  case "sync": {
    if (daemonPid()) die("The daemon is running and already syncing. See `localsync logs`.");
    requireStore();
    process.env.PUSHWORK_SUBDUCTION_SERVER = (readConfig() ?? die("Not set up.")).endpoint;
    await cycle("manual");
    process.exit(0);
  }
  default:
    console.log(`localsync — sync folders under ~ between machines over Tailscale (pushwork)

  localsync start              Start the daemon (first machine: becomes the host)
  localsync stop | restart     Stop / restart it (macOS: launchd, survives login)
  localsync status | logs      State, or follow the log
  localsync add <path> [--as <name>]   Sync a folder (inside ~) under a name
  localsync map <name> <path>  Keep that folder at a different path on this machine
  localsync map <name> --skip | --default   Don't sync it here / use the shared path
  localsync rm <name|path>...  Stop syncing (files stay where they are)
  localsync ls                 Folders, and where each lives on this machine
  localsync repo               Print the command to run on the other machine
  localsync repo add <url> <endpoint>   Join a host and start syncing
  localsync sync               One cycle now (daemon stopped)
  localsync run                Run in the foreground

State lives in ${tilde(DIR)}. Overwritten local edits are backed up to ${tilde(BACKUP)}.
Env: LOCALSYNC_PORT (${PORT}), LOCALSYNC_DEBOUNCE_MS (${DEBOUNCE_MS}), LOCALSYNC_POLL_MS (${POLL_MS}), LOCALSYNC_DIR`);
}
