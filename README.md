# omp-skill-state

An [omp](https://omp.sh) plugin that runs a procedural skill against an explicit execution state instead of a growing transcript. The design is in `docs/spec.md`; the vocabulary is in `CONTEXT.md`.

Status: skeleton. The extension loads, shows one notice when a session starts, and changes nothing else.

## Layout

| Path | Role |
| --- | --- |
| `package.json` | Plugin manifest: `"omp": { "extensions": ["./index.ts"] }` |
| `index.ts` | The extension. omp imports the TypeScript directly; there is no build step. |
| `index.test.ts` | Unit tests for the factory contract |
| `docs/spec.md`, `docs/adr/`, `CONTEXT.md` | Design, decisions, glossary |

## Develop

You need [bun](https://bun.sh) and omp (`omp --version`).

```sh
bun install        # dev dependencies: extension types, tsc, bun test types
bun run typecheck  # tsc --noEmit
bun test           # unit tests
```

`bun install` reports two blocked postinstall scripts (`onnxruntime-node`, `protobufjs`). They belong to transitive dependencies of the types package and are not needed. Leave them blocked.

## Install into omp

Link this checkout as a development plugin:

```sh
omp plugin link "C:\projects\_llm\omp-skill-state"
omp plugin list     # omp-skill-state, enabled
omp plugin doctor   # 0 errors
```

`link` creates a junction at `~/.omp/plugins/node_modules/omp-skill-state` and an enabled entry in `~/.omp/plugins/omp-plugins.lock.json`. Changes to `index.ts` take effect at the next session start. Remove the link with `omp plugin uninstall omp-skill-state`.

Each new main session then shows one notice:

```
omp-skill-state loaded (inert)
```

Subagent sessions stay silent. Nothing else changes.

## Extension types

`index.ts` imports `ExtensionAPI` as a type only. At run time omp supplies the real API, so the plugin has no runtime dependency.

The types come from the published `@oh-my-pi/pi-coding-agent` package, pinned to the version of the installed omp (`omp --version`). The published package ships `dist/types/*.d.ts`, which keeps `tsc` fast and independent of the harness source.

### When the published types lag the local checkout

The spec names a `file:` dependency on the harness checkout at `C:\projects\_llm\oh-my-pi\packages\coding-agent` as the fallback:

```json
"devDependencies": {
  "@oh-my-pi/pi-coding-agent": "file:../oh-my-pi/packages/coding-agent"
}
```

This does not work as-is. Two reasons, both verified:

1. The checkout is a workspace member. Its dependencies use `catalog:` specifiers, which bun resolves only inside the monorepo. From this repo, `bun install` fails with `@opentelemetry/resources@catalog: failed to resolve` and similar errors.
2. The checkout's `types` entry points at `src/index.ts`, not at `.d.ts` files. `tsc` would then check the harness source, which needs the monorepo's own dependencies and tsconfig.

The checkout is read-only, so installing its dependencies in place is not an option. Do this instead:

- Bump the pin to the newest published version first. Publishes track the checkout closely; `npm view @oh-my-pi/pi-coding-agent version` shows the latest.
- Only a tarball packed from a copy of the monorepo, after its own install and build, could serve a `file:` dependency. That path is not verified here.
