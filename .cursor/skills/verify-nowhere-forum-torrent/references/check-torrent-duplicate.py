"""Run the forum e2e test with an added second publish assertion in a scratch checkout."""
from pathlib import Path

path = Path("tests/e2e/live-commands.test.ts")
anchor = "            expect(checkedAfterPublish.duplicate?.reason).toBe('infohash');"
addition = """
            const duplicateFailure = await cliFailure(
              'forum', 'torrent', 'publish', forum.fragment, '--torrent-file',
              torrentFilePath, '--category', 'Docs > Manuals', '--secret', owner.nsec,
              '--relay', relay.url, '--json',
            );
            expect(duplicateFailure).toContain('Torrent already exists');
"""
source = path.read_text()
if source.count(anchor) != 1 or addition in source:
    raise SystemExit("The test anchor changed or the duplicate check is already present")
path.write_text(source.replace(anchor, anchor + "\n" + addition))
