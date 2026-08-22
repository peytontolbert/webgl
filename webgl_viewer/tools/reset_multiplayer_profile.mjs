#!/usr/bin/env node
// Safely reset one authoritative multiplayer profile to a supplied recovery point.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const readArg = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : null;
};
const profileFile = readArg('--profiles');
const token = readArg('--token');
const x = Number(readArg('--x'));
const y = Number(readArg('--y'));
const z = Number(readArg('--z'));
if (!profileFile || !token || ![x, y, z].every(Number.isFinite)) {
    throw new Error('usage: reset_multiplayer_profile.mjs --profiles <file> --token <token> --x <x> --y <y> --z <z>');
}
const resolved = path.resolve(profileFile);
const profiles = JSON.parse(fs.readFileSync(resolved, 'utf8'));
if (!profiles[token] || typeof profiles[token] !== 'object') throw new Error('profile token was not found');
const backup = `${resolved}.before-recovery-${Date.now()}.bak`;
fs.copyFileSync(resolved, backup);
profiles[token].position = [x, y, z];
profiles[token].updatedAt = new Date().toISOString();
const temporary = `${resolved}.recovery-${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(profiles, null, 2)}\n`, 'utf8');
fs.renameSync(temporary, resolved);
console.log(JSON.stringify({ reset: true, profile: token, position: profiles[token].position, backup }));
