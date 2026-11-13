// Writes <scratch>/guest.wsb, the Windows Sandbox configuration for one acceptance run.
//   node test/real-cindy/make-sandbox-config.mjs <scratch>
// Every host location comes from <scratch>/run.json; nothing about the host is written into a tracked file.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const scratch = process.argv[2];
if (!scratch) throw new Error('usage: make-sandbox-config.mjs <scratch>');
const run = JSON.parse(readFileSync(join(scratch, 'run.json'), 'utf8'));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

const xml = `<Configuration>
  <VGpu>Disable</VGpu>
  <Networking>Enable</Networking>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <PrinterRedirection>Disable</PrinterRedirection>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <ProtectedClient>Disable</ProtectedClient>
  <MemoryInMB>8192</MemoryInMB>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>${esc(run.stage)}</HostFolder>
      <SandboxFolder>C:\\stage</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>${esc(run.out)}</HostFolder>
      <SandboxFolder>C:\\out</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
</Configuration>
`;
const file = join(scratch, 'guest.wsb');
writeFileSync(file, xml);
process.stdout.write(file);
