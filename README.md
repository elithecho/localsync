# localsync

Sync folders between your machines over [Tailscale](https://tailscale.com).
No cloud and no public server: one of your machines hosts the sync server on its
tailnet address, and the others connect to it.

> Experimental. It depends on nightly and prerelease builds of its sync stack
> (see [Dependencies](#dependencies)).

## Requirements

On every machine:

- Tailscale, logged in to the same tailnet
- [Bun](https://bun.sh)
- pushwork: `bun install -g pushwork`

```sh
git clone <this repo> ~/Workspace/localsync
ln -s ~/Workspace/localsync/bin/localsync ~/.local/bin/localsync
```

## Setup

**Machine A** (the host, which must be awake for syncing to happen):

```sh
localsync start
localsync add ~/.claude/skills ~/notes
localsync repo
```

`localsync start` reads this machine's Tailscale name and serves on
`ws://<machine>.<tailnet>.ts.net:18081`. That address listens on the tailnet
interface only, never on Wi-Fi or localhost. `localsync repo` prints the line
to run on the other machine.

**Machine B** (and any others):

```sh
localsync repo add automerge:... ws://<machine-a>.<tailnet>.ts.net:18081
```

B pulls every registered folder into the same place under its own home, then
keeps syncing. From then on either machine can `add` or `rm` folders, because
the list of folders syncs too.

## Commands

| Command | Effect |
| --- | --- |
| `start` / `stop` / `restart` | Run the daemon. macOS: launchd, restarts at login. Linux/WSL: background process |
| `status` / `logs` | Show state, or follow the log |
| `add <path>...` | Sync these paths (must be inside `~`) |
| `rm <path>...` | Stop syncing. Files stay on every machine |
| `ls` | List registered paths |
| `repo` | Print the join command for another machine |
| `repo add <url> <endpoint>` | Join a host and start syncing |
| `sync` | Run one sync now (daemon stopped) |

Settings via environment: `LOCALSYNC_PORT` (18081), `LOCALSYNC_DEBOUNCE_MS`
(2000), `LOCALSYNC_POLL_MS` (15000), `LOCALSYNC_DIR` (`~/.localsync`).

## How it works

- `~/.localsync/store/` is one [pushwork](https://www.npmjs.com/package/pushwork)
  repo. It holds a copy of each registered folder, plus the `registry` file that
  lists them.
- The daemon watches the registered folders and syncs 2s after the last change.
  It also checks every 15s so it picks up the other machine's changes. Only
  changed files are copied, and deletions sync too.
- Paths are stored relative to `~`, so `/Users/me/x` on a Mac and `/home/me/x`
  on Linux are the same folder. Symlinks are stored as their targets, also
  relative to `~`.
- If an incoming change would overwrite a local edit that hasn't synced yet,
  the local copy goes to `~/.localsync/backup/` first.
- `.git`, `node_modules`, `.DS_Store` and `*.tmp` are skipped.

## Security

The server runs with `--auth open`: **any device that can reach your tailnet
can read and write the synced folders.** That's fine for a personal tailnet.
On a shared tailnet, restrict port 18081 with
[Tailscale ACLs](https://tailscale.com/kb/1018/acls) or don't use localsync.
Don't sync folders that hold secrets you wouldn't want on every device.

## Limits

- Prebuilt sync servers exist for macOS arm64 and Linux x64/arm64. Windows works
  through WSL. There is no systemd unit.
- Only the host runs the server. If it's asleep, nothing syncs until it wakes.
- Each file keeps its edit history, so large or fast-changing files (build
  output, binaries) make the store grow. Sync text-like folders.
- Every machine syncs every registered folder. Choosing per machine isn't
  supported yet.

## Dependencies

Neither is bundled. localsync runs whatever you have installed.

| Dependency | How it's used | License |
| --- | --- | --- |
| [pushwork](https://www.npmjs.com/package/pushwork) | You install it; localsync runs its CLI | MIT OR Apache-2.0 |
| [Subduction](https://github.com/inkandswitch/subduction) | The host downloads a pinned nightly (`v0.22.0-nightly.2026-11-26`) to `~/.local/bin/subduction` | MIT OR Apache-2.0 |

## License

[MIT](LICENSE)
