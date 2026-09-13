# dev-control-center

A minimal local web application for keeping track of development projects.

## Run

Requires Node.js 20 or newer.

```sh
./start.sh
```

Open <http://localhost:3000>. Set `HOST`, `PORT`, or `DCC_DATA_FILE` to change
the listening address, port, or persistent project data file. Process ownership
is stored beside the project data by default; set `DCC_PROCESS_FILE` to change
that location.

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
PORT=3100 ./start.sh
```

The default `127.0.0.1` binding is local-only. To listen on a particular
Tailscale address without exposing the service on every network interface, use:

```sh
HOST="$(tailscale ip -4)" PORT=3000 ./start.sh
```

Dev Control Center has no authentication or TLS. Only bind it to a trusted
interface and restrict access with the host firewall and Tailscale policy. Avoid
`HOST=0.0.0.0` unless every reachable network is trusted. Registered Start
Commands run as the Dev Control Center user, and Git actions modify the selected
repositories, so only register trusted paths and commands. Git branch switching
and fast-forward updates require a clean working tree; the application never
offers reset, force-push, or arbitrary Git command execution.

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
