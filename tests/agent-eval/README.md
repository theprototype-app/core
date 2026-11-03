# Agent eval set (roadmap 85)

Twenty-one spoken requests against one fixed room (`scene.json`), each run as a fresh `claude -p` against a stand-in for
the claude.ai connector (`mock-connector.mjs`). The mock lists a Worker catalog through the Worker's **own** policy
module (cloud `worker-mcp/src/catalog.js`, so tool families resolve exactly as in production), answers from the fixed
scene and logs every call. `run.mjs` scores each request **pass / partial / fail** from the calls (`requests.json` says
what counts; read-only calls never count against a request).

Run it for any release that changes connector tools, for the LIVE catalog and the release's, same model, same day:

```sh
node tests/agent-eval/run.mjs live <live tools.json> <live worker src/catalog.js> test-results/<lane>/eval --jobs 3
node tests/agent-eval/run.mjs rel  ../cloud-<lane>/worker-mcp/catalog/tools.json ../cloud-<lane>/worker-mcp/src/catalog.js test-results/<lane>/eval --jobs 3
```

The live pair: `git show origin/main:worker-mcp/catalog/tools.json` and `…:worker-mcp/src/catalog.js` from the cloud
repo. `--model` (sonnet), `--only a,b`. Each run writes `<out>/<label>/score.json` plus one `.out.json` and call log per
request. The `claude -p` runs from an empty temp folder outside any repo (inside core it loads CLAUDE.md: ~$1 a run
instead of ~$0.02), with only the mock connector's tools.

The point is the difference between the two catalogs, not the absolute number: a listing that makes Claude choose worse
shows up here before the owner re-syncs it in claude.ai.

| release | live | release | model |
|---|---|---|---|
| 1.56.0 (85a) | 11.5 / 21 (22 tools) | 20 / 21 (27 tools: + create_shape, edit_shape, set_look, assets, undo_last) | sonnet |
