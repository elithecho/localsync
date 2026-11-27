#!/usr/bin/env bun
// localsync: keep registered folders under ~ in sync between machines over
// Tailscale, using one pushwork repo (~/.localsync/store) as the shared copy.
//
//   machine A: localsync start; localsync add ~/x; localsync repo
//   machine B: localsync repo add <automerge-url> <ws-endpoint>
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
const FILES = join(STORE, "files"); // mirrored files, keyed by path relative to ~
const REGISTRY = join(STORE, "registry"); // one ~-relative path per line; synced
const OPS = join(DIR, "registry.ops"); // add/rm queued for the daemon (never write the store mid-sync)
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
const LABEL = "dev.localsync";
const PLIST = join(HOME, "Library/LaunchAgents", `${LABEL}.plist`);
const SELF = import.meta.path;
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

function readRegistry(): string[] {
  if (!existsSync(REGISTRY)) return [];
  const lines = readFileSync(REGISTRY, "utf8").split("\n").map((l) => l.trim());
  return [...new Set(lines.filter((l) => l && !l.startsWith("#")))];
}

function writeRegistry(paths: string[]) {
  writeFileSync(REGISTRY, paths.join("\n") + (paths.length ? "\n" : ""));
}

// Registry edits from the CLI are queued as "+rel"/"-rel" lines while the
// daemon runs, because pushwork would overwrite a file changed mid-sync.
function withOps(paths: string[], file = OPS): string[] {
  if (!existsSync(file)) return paths;
  const out = [...paths];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const rel = line.slice(1).trim();
    if (!rel) continue;
    if (line[0] === "+" && !out.includes(rel)) out.push(rel);
    const i = out.indexOf(rel);
    if (line[0] === "-" && i >= 0) out.splice(i, 1);
  }
  return out;
}

// Daemon side: fold queued edits into the store's registry between syncs.
function applyOps() {
  if (!existsSync(OPS)) return;
  const taking = OPS + ".taking";
  renameSync(OPS, taking); // a concurrent CLI append lands in a fresh OPS file
  writeRegistry(withOps(readRegistry(), taking));
  rmSync(taking);
}

// "~/a/b/", "/Users/me/a/b" -> "a/b". Only paths strictly inside ~.
function toRel(input: string): string {
  const abs = resolve(untilde(input));
  const rel = relative(HOME, abs);
  if (!rel || rel.startsWith("..") || rel.startsWith("/")) die(`Only paths inside ${HOME} can be synced: ${input}`);
  return rel;
}

const inScope = (rel: string, paths: string[]) => paths.some((p) => rel === p || rel.startsWith(p + "/"));

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

function listHome(paths: string[]): Listing {
  const out: Listing = new Map();
  for (const p of paths) walk(HOME, p, out, "home");
  return out;
}

// Everything in the store, or only what falls under `paths`.
function listStore(paths?: string[]): Listing {
  const out: Listing = new Map();
  walk(FILES, "", out, "store");
  if (paths) for (const rel of out.keys()) if (!inScope(rel, paths)) out.delete(rel);
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
    atomicCopy(join(HOME, rel), dst);
  }
}

function dropFromStore(rel: string) {
  for (const p of [join(FILES, rel), join(FILES, rel + LINK)]) {
    removePath(p);
    prune(FILES, p);
  }
}

function toHome(rel: string, v: string) {
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
    atomicCopy(join(FILES, rel), dst);
  }
}

function dropFromHome(rel: string) {
  if (throughLink(HOME, rel)) return;
  const p = join(HOME, rel);
  removePath(p);
  prune(HOME, p);
}

let backupStamp = "";
function backup(rel: string) {
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

// ~ -> store: what changed locally since the baseline. With no baseline (first
// run), only files the store lacks go out, and nothing is deleted.
function exportLocal(paths: string[], base: Listing | undefined): string[] {
  const local = listHome(paths);
  const changed: string[] = [];
  if (!base) {
    const store = listStore(paths);
    for (const [rel, v] of local) if (!store.has(rel)) (toStore(rel, v), changed.push(rel));
    return changed;
  }
  for (const [rel, v] of local) if (base.get(rel) !== v && inScope(rel, paths)) (toStore(rel, v), changed.push(rel));
  for (const rel of base.keys()) if (inScope(rel, paths) && !local.has(rel)) (dropFromStore(rel), changed.push("-" + rel));
  return changed;
}

// store -> ~: what pushwork changed (or, on a first run, anything that differs).
// A local file that would be overwritten while holding an unsynced edit is backed up first.
function importRemote(paths: string[], before: Listing, after: Listing, firstRun: boolean): string[] {
  const local = listHome(paths);
  const changed: string[] = [];
  backupStamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const [rel, v] of after) {
    if (local.get(rel) === v) continue;
    if (!firstRun && before.get(rel) === v) continue;
    if (local.has(rel) && local.get(rel) !== before.get(rel)) backup(rel);
    toHome(rel, v);
    changed.push(rel);
  }
  for (const [rel, v] of before) {
    if (after.has(rel) || !local.has(rel)) continue;
    if (local.get(rel) !== v) backup(rel);
    dropFromHome(rel);
    changed.push("-" + rel);
  }
  return changed;
}

function pushworkSync() {
  const r = spawnSync("pushwork", ["--quiet", "sync"], { cwd: STORE, encoding: "utf8", env: process.env });
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
    const base = loadBaseline();
    const out = exportLocal(readRegistry(), base);
    // A watch event with nothing new (e.g. our own import) needs no network trip.
    if (reason === "watch" && out.length === 0) return;
    // Snapshot the whole store, then scope it with the registry as it is after
    // the sync, so a path removed elsewhere is dropped from both sides of the
    // comparison instead of looking like a mass deletion.
    const rawBefore = listStore();
    pushworkSync();
    const paths = readRegistry();
    const scope = (l: Listing) => new Map([...l].filter(([rel]) => inScope(rel, paths)));
    const before = scope(rawBefore);
    const after = listStore(paths);
    const inn = importRemote(paths, before, after, !base);
    writeFileSync(BASELINE, JSON.stringify(Object.fromEntries(listStore(paths))));
    if (out.length) log(`[${reason}] pushed ${summary(out)}`);
    if (inn.length) log(`[${reason}] pulled ${summary(inn)}`);
    rewatch(paths);
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
function rewatch(paths: string[]) {
  for (const [p, w] of watchers) if (!paths.some((rel) => join(HOME, rel) === p)) (w.close(), watchers.delete(p));
  for (const rel of paths) {
    const p = join(HOME, rel);
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
  writeFileSync(PID, String(process.pid));
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGUSR1", () => cycle("registry")); // sent by add/rm
  process.on("exit", () => {
    try {
      if (readFileSync(PID, "utf8") === String(process.pid)) rmSync(PID);
    } catch {}
  });

  process.env.PUSHWORK_SUBDUCTION_SERVER = config.endpoint;
  if (config.role === "host") await superviseServer(config.ip, config.dns);
  if (!existsSync(join(STORE, ".pushwork/config.json"))) die(`No pushwork store at ${STORE}.`);
  log(`localsync ${config.role}: ${config.endpoint}, ${readRegistry().length} paths, debounce ${DEBOUNCE_MS}ms, poll ${POLL_MS}ms`);

  rewatch(readRegistry());
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
  const r = spawnSync("pushwork", args, { cwd, encoding: "utf8", env: process.env });
  if (r.status !== 0) die(`pushwork ${args.join(" ")} failed: ${`${r.stdout ?? ""}${r.stderr ?? ""}`.trim()}`);
  return r.stdout.trim();
}

// First `start` on a machine with no config makes it the host.
function setupHost() {
  const self = tailnetSelf() ?? die("Tailscale is not running here. To join another machine instead, use `localsync repo add <url> <endpoint>`.");
  const endpoint = `ws://${self.dns}:${PORT}`;
  mkdirSync(FILES, { recursive: true });
  if (!existsSync(REGISTRY)) writeRegistry([]);
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

// Daemon running: queue the edit and wake it. Otherwise write the store directly.
function editRegistry(op: "+" | "-", rel: string, next: string[]) {
  const pid = daemonPid();
  if (!pid) return writeRegistry(next);
  writeFileSync(OPS, `${op}${rel}\n`, { flag: "a" });
  process.kill(pid, "SIGUSR1");
}

function requireStore() {
  if (!existsSync(join(STORE, ".pushwork/config.json"))) die("Not set up. Run `localsync start` or `localsync repo add <url> <endpoint>` first.");
}

function add(input: string) {
  requireStore();
  const rel = toRel(input);
  if (!lstatSync(join(HOME, rel), { throwIfNoEntry: false })) die(`Not found: ${input}`);
  const paths = withOps(readRegistry());
  if (paths.includes(rel)) return console.log(`Already syncing ~/${rel}`);
  const clash = paths.find((p) => rel.startsWith(p + "/") || p.startsWith(rel + "/"));
  if (clash) die(`~/${rel} overlaps ~/${clash}, which is already registered.`);
  editRegistry("+", rel, [...paths, rel]);
  console.log(`Syncing ~/${rel}`);
}

function rm(input: string) {
  requireStore();
  const rel = toRel(input);
  const paths = withOps(readRegistry());
  if (!paths.includes(rel)) die(`Not registered: ~/${rel}`);
  editRegistry("-", rel, paths.filter((p) => p !== rel));
  console.log(`Stopped syncing ~/${rel} (files stay on every machine)`);
}

function repoAdd(url?: string, endpoint?: string) {
  if (!url?.startsWith("automerge:") || !endpoint?.startsWith("ws")) die("usage: localsync repo add <automerge:...> <ws://host:port>");
  if (readConfig()) die(`Already set up (${CONFIG}). Remove ${DIR} to start over.`);
  if (existsSync(STORE) && readdirSync(STORE).length) die(`${STORE} is not empty.`);
  process.env.PUSHWORK_SUBDUCTION_SERVER = endpoint;
  mkdirSync(DIR, { recursive: true });
  console.log("Cloning…");
  pushwork(["--quiet", "clone", url, STORE], DIR);
  writeConfig({ role: "peer", endpoint });
  console.log(`Joined. Paths: ${readRegistry().map((p) => "~/" + p).join(", ") || "(none yet)"}`);
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
    console.log(`Paths    ${readRegistry().length}`);
    console.log(`Log      ${LOG}`);
    break;
  }
  case "logs":
    spawn("tail", ["-n", "50", "-f", LOG], { stdio: "inherit" });
    break;
  case "run":
    await daemon();
    break;
  case "add":
    if (!args.length) die("usage: localsync add <path>...");
    for (const a of args) add(a);
    break;
  case "rm":
    if (!args.length) die("usage: localsync rm <path>...");
    for (const a of args) rm(a);
    break;
  case "ls":
    for (const p of withOps(readRegistry())) console.log(`~/${p}${existsSync(join(HOME, p)) ? "" : "  (not here yet)"}`);
    break;
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
  localsync add <path>...      Sync these paths (must be inside ~)
  localsync rm <path>...       Stop syncing (files stay where they are)
  localsync ls                 Registered paths
  localsync repo               Print the command to run on the other machine
  localsync repo add <url> <endpoint>   Join a host and start syncing
  localsync sync               One cycle now (daemon stopped)
  localsync run                Run in the foreground

State lives in ${tilde(DIR)}. Overwritten local edits are backed up to ${tilde(BACKUP)}.
Env: LOCALSYNC_PORT (${PORT}), LOCALSYNC_DEBOUNCE_MS (${DEBOUNCE_MS}), LOCALSYNC_POLL_MS (${POLL_MS}), LOCALSYNC_DIR`);
}
