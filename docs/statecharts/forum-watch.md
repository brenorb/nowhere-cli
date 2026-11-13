# Watch Nowhere forum events

![Statechart of the first snapshot, live polling, and watch shutdown](forum-watch.svg)

[Mermaid source](forum-watch.mmd) · [Model and source replay](../../.cursor/skills/verify-nowhere-forum-watch/SKILL.md)

Pstack explored 160 states and checked `NoRepeatedEvent` and `NoDeadlock`. An event can appear in multiple relay results, but watch prints it once. The chart abstracts the exact poll interval and event contents and omits steps that stay in one chart state.

From the repository root, with pstack's `statechart` command and TLC available, regenerate in a new directory.

```sh
skill=.cursor/skills/verify-nowhere-forum-watch
statechart "$skill/Watch.tla" --view docs/statecharts/forum-watch.view.mjs \
  --out /tmp/nowhere-forum-watch
```
