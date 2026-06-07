import { getConnectionInfo, buildFolderPaths } from '../src/config.js';
import { withMcp } from '../src/mcp-client.js';

async function main() {
  const { mcpCommand, accessToken, config } = getConnectionInfo();
  if (!config) {
    console.error('No config');
    return;
  }
  const projectId = config.projectId;
  const folderId = config.folderId;

  await withMcp(mcpCommand, accessToken, async (mcp) => {
    const foldersRes = await mcp.callToolAndGetJson('search_folders', { projectId });
    const folders = Array.isArray(foldersRes) ? foldersRes : (foldersRes.folders || foldersRes.data || []);
    console.log('All Folders in Project:');
    for (const f of folders) {
      console.log(`- Name: "${f.name}", ID: "${f.id}", ParentID: "${f.parentFolderId}"`);
    }
    const paths = buildFolderPaths(folders, folderId);
    console.log('\nResolved Folder Paths (relative to target folder):', paths);
  });
}

main().catch(console.error);
