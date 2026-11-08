import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

import { hasErrorCode, PluginScriptsError } from './errors.mjs';

const NPM_NOT_FOUND = 'Could not find npm. Install npm and ensure its directory is on PATH, then retry update-api.';

/**
 * Finds npm without treating another package manager's npm_execpath as npm.
 * Windows uses npm.exe or npm-cli.js directly to avoid a shell for npm.cmd.
 * @param {{ platform?: string, npmExecPath?: string, nodePath?: string, searchPath?: string }} [options]
 * @returns {{ file: string, args: string[] }}
 */
export function resolveNpmCommand({
    platform = process.platform,
    npmExecPath = process.env.npm_execpath,
    nodePath = process.execPath,
    searchPath = process.env.PATH ?? '',
} = {}) {
    if (npmExecPath && path.basename(npmExecPath) === 'npm-cli.js' && isFile(npmExecPath)) {
        return { file: nodePath, args: [npmExecPath] };
    }
    if (platform !== 'win32') return { file: 'npm', args: [] };

    const directories = [...searchPath.split(path.delimiter).filter(Boolean), path.dirname(nodePath)];
    for (const directory of directories) {
        const npmExe = path.join(directory, 'npm.exe');
        if (isFile(npmExe)) return { file: npmExe, args: [] };
        const npmCli = path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
        if (isFile(npmCli)) return { file: nodePath, args: [npmCli] };
    }
    throw new PluginScriptsError(NPM_NOT_FOUND);
}

/** @param {string} file */
function isFile(file) {
    try {
        return statSync(file).isFile();
    } catch {
        return false;
    }
}

/**
 * Runs npm with fixed arguments, without a shell.
 * @param {string[]} args
 * @param {string} cwd
 */
export function runNpm(args, cwd) {
    const command = resolveNpmCommand();
    try {
        execFileSync(command.file, [...command.args, ...args], { cwd, stdio: 'pipe' });
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) throw new PluginScriptsError(NPM_NOT_FOUND);
        throw error;
    }
}
