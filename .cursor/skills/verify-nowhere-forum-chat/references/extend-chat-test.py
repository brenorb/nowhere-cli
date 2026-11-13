"""Add peer selection assertions to the local relay test in a scratch checkout."""
from pathlib import Path

path = Path("tests/e2e/live-commands.test.ts")
text = path.read_text()
anchor = "              expect(listed.messages[0]?.peerPubkey).toBe(owner.pubkeyHex);"
addition = """
              const otherAuthor = await cli(
                'forum', 'private', 'list', forum.fragment, '--session-secret', session.nsec,
                '--peer-pubkey', session.pubkeyHex, '--relay', relay.url, '--json',
              );
              expect(otherAuthor.messages).toHaveLength(0);
"""
if text.count(anchor) != 1 or addition in text:
    raise SystemExit("The test anchor changed or the check is already present")
path.write_text(text.replace(anchor, anchor + "\n" + addition))
