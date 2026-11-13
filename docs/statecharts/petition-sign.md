# Sign a Nowhere petition

![Statechart for validating and submitting a petition signature](petition-sign.svg)

[Mermaid source](petition-sign.mmd) · [Model and local replay](../../.cursor/skills/verify-nowhere-petition/SKILL.md)

Pstack explored 12 states and checked `PublishReadySignature` and `NoDeadlock`. The chart omits steps that stay in one chart state and abstracts identity choice, cryptographic details, and individual relay responses.

From the repository root, with pstack's `statechart` command and TLC available, regenerate in a new directory.

```sh
skill=.cursor/skills/verify-nowhere-petition
statechart "$skill/Signature.tla" --view docs/statecharts/petition-sign.view.mjs \
  --out /tmp/nowhere-petition-sign
```
