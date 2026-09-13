# dev-control-center

A minimal local web application for keeping track of development projects.

## Run

Requires Node.js 20 or newer.

```sh
npm start
```

Open <http://localhost:3000>. Set `HOST`, `PORT`, or `DCC_DATA_FILE` to change
the listening address, port, or persistent project data file. Process ownership
is stored beside the project data by default; set `DCC_PROCESS_FILE` to change
that location.

## Test

```sh
npm test
```
