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

pushwork comes pinned in `package.json` and runs under Bun, so you don't need
Node.js or a global install.

```sh
git clone https://github.com/elithecho/localsync.git ~/Workspace/localsync
cd ~/Workspace/localsync && bun install
ln -s ~/Workspace/localsync/bin/localsync ~/.local/bin/localsync
```

## Setup

**Machine A** (the host, which must be awake for syncing to happen):

```sh
localsync start
localsync add ~/.claude/skills ~/notes
localsync add ~/Workspace/app/.scratch --as app-scratch
localsync repo
```

Each folder gets a name: `--as`, or one made from the path (`claude-skills`,
`notes`).

`localsync start` reads this machine's Tailscale name and serves on
`ws://<machine>.<tailnet>.ts.net:18081`. That address listens on the tailnet
interface only, never on Wi-Fi or localhost. `localsync repo` prints the line
to run on the other machine.

**Machine B** (and any others):

```sh
localsync repo add automerge:... ws://<machine-a>.<tailnet>.ts.net:18081
```

B pulls every folder to the same path under its own home, then keeps syncing.
If B keeps a folder somewhere else, point the name at it. That's best done
before B's first sync:

```sh
localsync map app-scratch ~/code/app/.scratch   # this machine only
localsync map notes --skip                      # don't sync this one here
```

From then on either machine can `add` or `rm` folders, because the list of
folders syncs too. `localsync ls` shows each folder and where it lives on this
machine.

### Ignoring paths

Put a `.syncignore` at the top of a synced folder. It uses gitignore syntax and
syncs like any other file, so every machine follows the same rules:

```gitignore
# ~/.claude/.syncignore
projects/
todos/
*.log
```

An ignored path is left alone on every machine: it isn't pushed, pulled or
deleted. Files that already synced before you ignored them leave the shared
copy, and each machine keeps its own local copy. If you remove a rule, it takes
effect one sync later.

## Commands

| Command | Effect |
| --- | --- |
| `start` / `stop` / `restart` | Run the daemon. macOS: launchd, restarts at login. Linux/WSL: background process |
| `status` / `logs` | Show state, or follow the log |
| `add <path> [--as <name>]` | Sync a folder inside `~` under a name |
| `map <name> <path>` | Keep that folder at a different path on this machine |
| `map <name> --skip` / `--default` | Don't sync it here / go back to the shared path |
| `rm <name\|path>...` | Stop syncing. Files stay on every machine |
| `ls` | Folders, and where each lives on this machine |
| `repo` | Print the join command for another machine |
| `repo add <url> <endpoint>` | Join a host and start syncing |
| `sync` | Run one sync now (daemon stopped) |

Settings via environment: `LOCALSYNC_PORT` (18081), `LOCALSYNC_DEBOUNCE_MS`
(2000), `LOCALSYNC_POLL_MS` (15000), `LOCALSYNC_PUSHWORK_TIMEOUT_MS` (120000),
`LOCALSYNC_DIR` (`~/.localsync`).

## How it works

- `~/.localsync/store/` is one [pushwork](https://www.npmjs.com/package/pushwork)
  repo. It holds a copy of each folder under its name, plus the `registry` file
  that lists each name and its default path. Each machine's own paths live in
  `~/.localsync/paths.json`, which doesn't sync.
- The daemon watches the registered folders and syncs 2s after the last change.
  It also checks every 15s so it picks up the other machine's changes. Only
  changed files are copied, and deletions sync too.
- Default paths are relative to `~`, so `/Users/me/x` on a Mac and `/home/me/x`
  on Linux are the same folder with no `map` needed. Symlinks are stored as
  their targets, also relative to `~`.
- When a folder first syncs on a machine (joining, a new `add`, or a `map` to a
  new path), the shared copy wins. Local-only files go up, and differing local
  files are backed up and replaced. Nothing is deleted on that first sync.
- Folders can't be nested inside each other. If two overlap on a machine, the
  one added later is ignored there until it's remapped.
- If an incoming change would overwrite a local edit that hasn't synced yet,
  the local copy goes to `~/.localsync/backup/` first.
- `.git`, `node_modules`, `.DS_Store` and `*.tmp` are always skipped, plus
  whatever each folder's `.syncignore` lists.

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
- Every machine syncs every folder unless it runs `map <name> --skip`.

## Dependencies

None is vendored into this repo. `bun install` fetches the npm packages, and the host downloads Subduction on first start.

| Dependency | How it's used | License |
| --- | --- | --- |
| [pushwork](https://www.npmjs.com/package/pushwork) | npm dependency pinned to `2.2.3` (`bun install`). localsync runs its CLI under Bun | MIT OR Apache-2.0 |
| [ignore](https://www.npmjs.com/package/ignore) | npm dependency pinned to `5.3.2`. Matches `.syncignore` patterns | MIT |
| [Subduction](https://github.com/inkandswitch/subduction) | The host downloads a pinned nightly (`v0.22.0-nightly.2026-11-26`) to `~/.local/bin/subduction` | MIT OR Apache-2.0 |

## License

[MIT](LICENSE)
