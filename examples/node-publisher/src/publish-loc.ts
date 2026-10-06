import { connectClient } from './client.js';
import { loadFixtureFromDisk } from './fixture.js';
import { publishLocFixture } from './loc-fixture.js';

const [url, directory, versionText, mode] = process.argv.slice(2);
const version = Number(versionText);
if (!url?.startsWith('https://') || !directory || (version !== 1 && version !== 4)
  || (mode !== 'wall-clock' && mode !== 'media') || (version === 1 && mode === 'media')) {
  throw new Error('Usage: publish-loc https://relay/moq fixture-directory 1|4 wall-clock|media (LOC-01 requires wall-clock)');
}
const fixture = loadFixtureFromDisk(directory);
const client = await connectClient(url, 'LOC publisher');
try { await publishLocFixture(client.conn, fixture, version, mode); }
finally { await client.close(); }
