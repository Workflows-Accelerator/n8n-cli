import { Command } from 'commander';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as output from '../output.js';
import {
  fetchLatestVersion,
  isNewerVersion,
  getChangelogEntries,
  formatChangelog,
} from '../update-check.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getPackageVersion(): string {
  const candidates = [
    path.resolve(__dirname, '../../package.json'),
    path.resolve(__dirname, '../package.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(c, 'utf-8'));
        if (pkg.version) return pkg.version;
      } catch {}
    }
  }
  return '1.0.0';
}

export function updateCommand(program: Command) {
  program
    .command('update')
    .alias('upgrade')
    .description('Update n8ncli to the latest published version')
    .option('--check', 'check for available updates without installing', false)
    .option('--force', 'force reinstallation even if already up to date', false)
    .option('--changelog', 'show release notes / what changed', false)
    .option('--tag <tag>', 'target npm distribution tag or version', 'latest')
    .action(async (options) => {
      try {
        const currentVersion = getPackageVersion();

        if (options.check) {
          output.log('Checking npm registry for updates...');
          const latestVersion = await fetchLatestVersion();
          if (!latestVersion) {
            output.warn('Could not reach npm registry to check for updates.');
            return;
          }
          output.log(`Current version: v${currentVersion}`);
          output.log(`Latest version:  v${latestVersion}`);
          if (isNewerVersion(latestVersion, currentVersion)) {
            output.log(`\n🔔 Update available! Run 'n8ncli update' to install v${latestVersion}.`);
            const changes = getChangelogEntries(currentVersion, 3);
            if (changes.length > 0) {
              output.log('\nWhat changed:');
              output.log(formatChangelog(changes));
            }
          } else {
            output.log('\nYou are on the latest version of n8ncli.');
          }
          return;
        }

        output.log('Checking for updates...');
        const latestVersion = await fetchLatestVersion();
        const targetVersion = latestVersion || currentVersion;

        if (!options.force && latestVersion && !isNewerVersion(latestVersion, currentVersion)) {
          output.log(`You are already on the latest version of n8ncli (v${currentVersion}).`);
          output.log(`To force reinstallation, run: n8ncli update --force`);
          if (options.changelog) {
            output.log('\nRecent changes:');
            output.log(formatChangelog(getChangelogEntries(undefined, 3)));
          }
          return;
        }

        output.log(`Updating @workflows-accelerator/n8n-cli to ${options.tag === 'latest' && latestVersion ? `v${latestVersion}` : options.tag}...`);
        const args = ['install', '-g', `@workflows-accelerator/n8n-cli@${options.tag || 'latest'}`];
        output.log(`Running: npm ${args.join(' ')}\n`);

        const res = spawnSync('npm', args, { stdio: 'inherit' });
        if (res.status === 0) {
          output.log(`\n✨ Successfully updated n8ncli to v${targetVersion}!`);
          const changes = getChangelogEntries(currentVersion, 3);
          if (changes.length > 0) {
            output.log('\nWhat changed:');
            output.log(formatChangelog(changes));
          }
        } else {
          output.error(`Update failed with exit code ${res.status}.`);
          output.log(`You can run the install command manually:\n  npm ${args.join(' ')}`);
          output.log(`If you encountered permission errors, try running with elevated permissions (e.g. sudo).`);
          process.exit(1);
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  program
    .command('changelog')
    .alias('whatsnew')
    .alias('changes')
    .description('Show release notes and what changed since last version')
    .option('--all', 'show all available release notes', false)
    .option('--limit <n>', 'number of recent releases to show', '5')
    .option('--from <version>', 'starting version to compare from')
    .action((options) => {
      try {
        const currentVersion = getPackageVersion();
        const limit = options.all ? 9999 : parseInt(options.limit, 10) || 5;
        const fromVersion = options.from;

        const entries = getChangelogEntries(fromVersion, limit);
        output.log(`\n=== n8ncli Release Notes (Current: v${currentVersion}) ===`);
        output.log(formatChangelog(entries));
        output.log(`\nFor full release history and discussions, visit:\n  https://github.com/Workflows-Accelerator/n8n-cli/releases\n`);
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
