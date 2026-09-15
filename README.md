# dev-control-center

A minimal local web application for keeping track of development projects.

## Run

Requires Node.js 20 or newer and tmux.

```sh
./start.sh
```

Open <http://localhost:8023>. The default `0.0.0.0` binding also accepts
connections through the machine's Tailscale IPv4 address or MagicDNS name, for
example `http://e-ryzen:8023`. Set `DCC_HOST`, `DCC_PORT`, or `DCC_DATA_FILE` to change
the listening address, port, or persistent project data file. tmux window
ownership is stored beside the project data by default; set `DCC_PROCESS_FILE`
to change that location.

Start Commands run in project-specific windows in the `dev-control-center` tmux
session. Attach to the session for direct interaction or to inspect output from
a command that has exited:

```sh
tmux attach-session -t dev-control-center
```

Windows are named automatically from the project directory and project identity.
Completed and failed windows remain available until the project is started again,
deleted, or Dev Control Center performs another explicit cleanup action. Set
`DCC_TMUX_SESSION` to use a different session name.

DCC uses `DCC_HOST` and `DCC_PORT` only for its own listener. Generic `HOST`
and `PORT` remain available for projects; for example, PurpleMux uses port 8022
by default. A Start Command such as `PORT=9000 ./start.sh` retains its explicit
project setting. Existing `config.sh` files must rename their DCC listener
settings from `HOST`/`PORT` to `DCC_HOST`/`DCC_PORT`.

The default startup path needs no configuration. On its first interactive run,
`start.sh` offers to create the Git-ignored `config.sh` for a persistent listen
address and port. You can also run the setup directly:

```sh
./start.sh --configure
```

[`sample_config.sh`](sample_config.sh) documents the generated settings and can
be copied to `config.sh` for manual setup. Environment variables take precedence
over values in `config.sh`, so one-off overrides continue to work:

```sh
DCC_PORT=3100 ./start.sh
```

The default binding listens on every IPv4 interface so both local and Tailscale
clients can connect. To restrict the service to the Tailscale interface, use:

```sh
DCC_HOST="$(tailscale ip -4)" ./start.sh
```

Dev Control Center has no authentication or TLS. Restrict access with the host
firewall and Tailscale policy; use `DCC_HOST=127.0.0.1` when remote access is not
needed. Registered Start Commands run as the Dev Control Center user, and Git
actions modify the selected repositories, so only register trusted paths and
commands. Git branch switching and fast-forward updates require a clean working
tree; the application never offers reset, force-push, or arbitrary Git command
execution.

## Test

```sh
npm test
```

The acceptance test starts an HTTP server on an ephemeral loopback port and
creates multiple temporary projects, managed processes, and Git repositories.
It drives the dashboard through the real API to verify status refresh, lifecycle
controls, safe Git refusal/success paths, and visible error feedback. All test
state is confined to the operating system's temporary directory and cleaned up
afterward; no existing repositories or configured application data are used.

The environment integration test starts DCC with a local configuration and a
fresh isolated tmux server, checking project defaults and explicit overrides.
To also test a real PurpleMux production build, with ports 8022 and 8023 free:

```sh
DCC_TEST_PURPLEMUX_DIR=/path/to/purplemux node --test test/project-environment.test.js
```

This test uses a temporary home directory for PurpleMux and an isolated tmux
server; the PurpleMux checkout must already have its production build and
dependencies installed.
