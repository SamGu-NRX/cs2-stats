#!/usr/bin/env node
/*
 * CS2 icon pack extractor.
 *
 * Copies official CS2 UI art (weapons, grenades, equipment, killfeed
 * modifiers, round-end reasons, economy, map radars and map emblems) out of
 * the user's own CS2 install and writes it as plain .svg (or .png when the
 * source is a raster texture, as radars are) plus manifest.json, which maps
 * stable semantic ids to files. The stats app loads the art from that folder
 * (app/src/ui/data/icons.ts) and falls back to text and drawn shapes without it.
 *
 * The output is Valve's artwork. It must never be committed to any repository.
 * The script refuses to write inside the repository it lives in.
 *
 * Run from the repository root (Windows; the script lowers its own priority so
 * it does not disturb a running game):
 *   node scripts/extract-icon-pack.cjs
 *
 * Options:
 *   --cs2 <path>  CS2 install folder ("Counter-Strike Global Offensive") or
 *                 its game\csgo\pak01_dir.vpk. Default: found through Steam's
 *                 libraryfolders.vdf.
 *   --out <path>  Output folder. Default: %APPDATA%\BotMatchStats\packs\icons
 *   --vrf <path>  Source2Viewer-CLI.exe (ValveResourceFormat CLI). Default:
 *                 %TEMP%\cs2-icon-pack\vrf\Source2Viewer-CLI.exe.
 *                 Official builds: https://github.com/ValveResourceFormat/ValveResourceFormat/releases
 *
 * Re-running replaces the previous output. The script only deletes what it
 * wrote itself: the category folders listed in CATEGORIES, manifest.json and
 * its marker file, and only in a folder that already carries that marker or
 * is empty. Temporary files go to %TEMP%\cs2-icon-pack\run.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MARKER = '.cs2-icon-pack';
const CATEGORIES = ['weapons', 'grenades', 'equipment', 'killfeed', 'round_end', 'economy', 'maps'];
// this script's own repository: Valve art must not land in its work tree
const PROTECTED_REPOS = [path.resolve(__dirname, '..')];

const EQ = 'panorama/images/icons/equipment/';
const UI = 'panorama/images/icons/ui/';
const DN = 'panorama/images/hud/deathnotice/';
const RADAR = 'panorama/images/overheadmaps/';
const EMBLEM = 'panorama/images/map_icons/';

// The maps the app has an overview transform for (MAPS in app/src/ui/data/maps.ts), and those drawn
// on two radars (LOWER_BELOW in app/src/ui/data/radar-levels.ts). The ids are the ones those files ask for.
const MAPS = ['de_dust2', 'de_mirage', 'de_inferno', 'de_nuke', 'de_overpass', 'de_ancient', 'de_anubis', 'de_vertigo', 'de_train'];
const TWO_FLOORS = ['de_nuke', 'de_vertigo', 'de_train'];

// Weapon ids are the game's names without the "weapon_" prefix. Every icon
// file in icons/equipment whose name starts with knife or bayonet is added too.
const WEAPONS = [
  'ak47', 'aug', 'awp', 'bizon', 'cz75a', 'deagle', 'elite', 'famas', 'fiveseven',
  'g3sg1', 'galilar', 'glock', 'hkp2000', 'm249', 'm4a1', 'm4a1_silencer',
  'm4a1_silencer_off', 'mac10', 'mag7', 'mp5sd', 'mp7', 'mp9', 'negev', 'nova',
  'p250', 'p90', 'revolver', 'sawedoff', 'scar20', 'sg556', 'ssg08', 'taser',
  'tec9', 'ump45', 'usp_silencer', 'usp_silencer_off', 'xm1014',
];
const GRENADES = ['hegrenade', 'flashbang', 'smokegrenade', 'molotov', 'incgrenade', 'decoy', 'inferno'];
const EQUIPMENT = [
  'c4', 'planted_c4', 'defuser', 'kevlar', 'assaultsuit', 'armor', 'armor_helmet',
  'helmet', 'heavy_armor', 'healthshot', 'world',
];

// Explicit id -> VPK path without extension. null means "looked for, does not
// exist in CS2"; it is reported as missing.
const FIXED = {
  killfeed: {
    headshot: DN + 'icon_headshot',
    wallbang: DN + 'penetrate',
    smoke: DN + 'smoke_kill',
    noscope: DN + 'noscope',
    blind: DN + 'blind_kill',
    inair: DN + 'inairkill',
    suicide: DN + 'icon_suicide',
    domination: DN + 'domination',
    revenge: DN + 'revenge',
    smokegrenade_impact: DN + 'smokegrenade_impact',
    flash_assist: EQ + 'flashbang_assist',
  },
  // Same files the game's scoreboard uses for round history
  // (dictRoundResultImage in panorama/scripts/common/gamerules_constants.js).
  round_end: {
    elimination: UI + 'kill',
    bomb_exploded: UI + 'bomb',
    bomb_defused: EQ + 'defuser',
    time: UI + 'timer',
    hostage_rescued: UI + 'rescue',
    round_win: UI + 'trophy',
    bomb_planted: UI + 'bomb_c4',
  },
  economy: {
    money: UI + 'dollar_sign',
    buyzone: UI + 'buyzone',
    eco_request: UI + 'chatwheel_requestecoround',
    eco: null,
    force_buy: null,
    full_buy: null,
  },
};

function fail(msg) {
  console.error('extract-icon-pack: ' + msg);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cs2' || a === '--out' || a === '--vrf') {
      if (i + 1 >= argv.length) fail(`${a} needs a value`);
      out[a.slice(2)] = argv[++i];
    } else if (a === '-h' || a === '--help') {
      console.log('usage: node scripts/extract-icon-pack.cjs [--cs2 <path>] [--out <path>] [--vrf <Source2Viewer-CLI.exe>]');
      process.exit(0);
    } else {
      fail(`unknown argument "${a}"`);
    }
  }
  return out;
}

// Case-insensitive containment check on Windows paths, done on both the
// literal path and the real path of its nearest existing ancestor so a
// junction or symlink into a repo is also caught.
function realOrNearest(p) {
  let cur = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  try { cur = fs.realpathSync.native(cur); } catch { /* keep literal */ }
  return path.join(cur, ...tail);
}

function isInside(child, parent) {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertOutAllowed(out) {
  const candidates = [path.resolve(out), realOrNearest(out)];
  for (const repo of PROTECTED_REPOS) {
    const repoReal = realOrNearest(repo);
    for (const c of candidates) {
      if (isInside(c, repo) || isInside(c, repoReal)) {
        fail(`refusing to write into ${repo} (resolved --out: ${c}). Valve assets must never land in a repo.`);
      }
    }
  }
  if (path.parse(path.resolve(out)).root === path.resolve(out)) fail(`refusing to use a drive root as --out: ${out}`);
}

function steamRoots() {
  const roots = [];
  const reg = spawnSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8' });
  const m = reg.stdout && reg.stdout.match(/SteamPath\s+REG_SZ\s+(.+)/);
  if (m) roots.push(path.normalize(m[1].trim()));
  roots.push('C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam');
  return [...new Set(roots)];
}

// libraryfolders.vdf: each numbered block has "path" and an "apps" block.
// CS2 is app 730.
function findCs2FromSteam() {
  for (const root of steamRoots()) {
    const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
    if (!fs.existsSync(vdf)) continue;
    const text = fs.readFileSync(vdf, 'utf8');
    const blocks = text.split(/\n\s*"\d+"\s*\n/).slice(1);
    const libs = [];
    for (const b of blocks) {
      const p = b.match(/"path"\s+"([^"]+)"/);
      if (!p) continue;
      const lib = p[1].replace(/\\\\/g, '\\');
      libs.push({ lib, has730: /"apps"[\s\S]*?"730"\s+"/.test(b) });
    }
    libs.sort((a, b) => Number(b.has730) - Number(a.has730));
    for (const { lib } of libs) {
      const install = path.join(lib, 'steamapps', 'common', 'Counter-Strike Global Offensive');
      if (fs.existsSync(path.join(install, 'game', 'csgo', 'pak01_dir.vpk'))) return install;
    }
  }
  fail('could not find CS2 through Steam libraryfolders.vdf; pass --cs2 <install folder or pak01_dir.vpk>');
}

function resolveVpk(cs2Arg) {
  if (!cs2Arg) {
    const install = findCs2FromSteam();
    return { vpk: path.join(install, 'game', 'csgo', 'pak01_dir.vpk'), install };
  }
  const p = path.resolve(cs2Arg);
  if (/\.vpk$/i.test(p)) {
    if (!fs.existsSync(p)) fail(`--cs2 VPK not found: ${p}`);
    return { vpk: p, install: path.resolve(p, '..', '..', '..') };
  }
  const vpk = path.join(p, 'game', 'csgo', 'pak01_dir.vpk');
  if (!fs.existsSync(vpk)) fail(`--cs2 has no game\\csgo\\pak01_dir.vpk: ${p}`);
  return { vpk, install: p };
}

function buildId(install) {
  const acf = path.join(install, '..', '..', 'appmanifest_730.acf');
  if (!fs.existsSync(acf)) return null;
  const m = fs.readFileSync(acf, 'utf8').match(/"buildid"\s+"(\d+)"/);
  return m ? m[1] : null;
}

function resolveVrf(arg) {
  const tmp = os.tmpdir();
  const candidates = arg ? [path.resolve(arg)] : [path.join(tmp, 'cs2-icon-pack', 'vrf', 'Source2Viewer-CLI.exe')];
  const hit = candidates.find((c) => fs.existsSync(c));
  if (!hit) fail(`Source2Viewer-CLI.exe not found; tried:\n  ${candidates.join('\n  ')}\nDownload cli-windows-x64.zip from https://github.com/ValveResourceFormat/ValveResourceFormat/releases or pass --vrf.`);
  return hit;
}

function runVrf(vrf, args) {
  const r = spawnSync(vrf, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (r.error) fail(`could not run ${vrf}: ${r.error.message}`);
  if (r.status !== 0) fail(`Source2Viewer-CLI exited ${r.status}:\n${(r.stderr || r.stdout || '').slice(-2000)}`);
  return r.stdout;
}

// Builds the wanted list: [{ category, id, src }] where src is a VPK path
// without extension, or null for "does not exist".
function wantedIcons(listing) {
  const wanted = [];
  for (const id of WEAPONS) wanted.push({ category: 'weapons', id, src: EQ + id });
  const knives = [...listing.keys()]
    .filter((k) => k.startsWith(EQ) && /^(knife|bayonet)/.test(k.slice(EQ.length)))
    .map((k) => k.slice(EQ.length))
    .sort();
  for (const id of knives) wanted.push({ category: 'weapons', id, src: EQ + id });
  for (const id of GRENADES) wanted.push({ category: 'grenades', id, src: EQ + id });
  for (const id of EQUIPMENT) wanted.push({ category: 'equipment', id, src: EQ + id });
  for (const [category, ids] of Object.entries(FIXED)) {
    for (const [id, src] of Object.entries(ids)) wanted.push({ category, id, src });
  }
  for (const map of MAPS) {
    wanted.push({ category: 'maps', id: `radar_${map}`, src: `${RADAR}${map}_radar_psd` });
    if (TWO_FLOORS.includes(map)) wanted.push({ category: 'maps', id: `radar_lower_${map}`, src: `${RADAR}${map}_lower_radar_psd` });
    wanted.push({ category: 'maps', id: `map_${map}`, src: `${EMBLEM}map_icon_${map}` });
  }
  return wanted;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  try { os.setPriority(0, os.constants.priority.PRIORITY_LOW); } catch { /* best effort; idle.cmd already sets it */ }

  const out = path.resolve(args.out || path.join(process.env.APPDATA || fail('APPDATA is not set'), 'BotMatchStats', 'packs', 'icons'));
  assertOutAllowed(out);
  if (fs.existsSync(out) && fs.readdirSync(out).length > 0 && !fs.existsSync(path.join(out, MARKER))) {
    fail(`${out} is not empty and was not written by this script (no ${MARKER} marker); refusing to overwrite it.`);
  }

  const { vpk, install } = resolveVpk(args.cs2);
  const vrf = resolveVrf(args.vrf);
  const build = buildId(install);
  const date = new Date().toISOString().slice(0, 10);
  console.log(`CS2 VPK: ${vpk}${build ? ` (build ${build})` : ''}`);
  console.log(`VRF:     ${vrf}`);
  console.log(`Output:  ${out}`);

  // 1. List the folders we draw from, so missing files are known up front.
  const prefixes = [EQ, UI, DN, RADAR, EMBLEM];
  const listing = new Map(); // path without extension -> full VPK path
  for (const line of runVrf(vrf, ['-i', vpk, '-l', '-f', prefixes.join(',')]).split(/\r?\n/)) {
    const m = line.match(/^(\S+)\.(vsvg_c|vtex_c|png|svg)\s/);
    if (m) listing.set(m[1], `${m[1]}.${m[2]}`);
  }
  if (listing.size === 0) fail('VPK listing returned no panorama icons; is this a CS2 pak01_dir.vpk?');

  const wanted = wantedIcons(listing);
  const found = wanted.filter((w) => w.src && listing.has(w.src));
  const missing = wanted.filter((w) => !w.src || !listing.has(w.src));

  // 2. Decompile only the needed files into a fresh staging folder.
  const stage = path.join(os.tmpdir(), 'cs2-icon-pack', 'run');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const files = [...new Set(found.map((w) => listing.get(w.src)))];
  runVrf(vrf, ['-i', vpk, '-d', '-f', files.join(','), '-o', stage]);

  // 3. Replace previous output: only our category folders, manifest and marker.
  fs.mkdirSync(out, { recursive: true });
  for (const c of CATEGORIES) fs.rmSync(path.join(out, c), { recursive: true, force: true });
  fs.rmSync(path.join(out, 'manifest.json'), { force: true });
  fs.writeFileSync(path.join(out, MARKER), 'Written by cs2-stats scripts/extract-icon-pack.cjs. Valve assets: never commit.\n');

  const icons = {};
  const decodeFailed = [];
  for (const w of found) {
    const ext = listing.get(w.src).endsWith('.vsvg_c') ? '.svg' : '.png';
    const staged = path.join(stage, ...(w.src + ext).split('/'));
    if (!fs.existsSync(staged)) { decodeFailed.push(w); continue; }
    if (icons[w.id]) fail(`duplicate icon id "${w.id}"`);
    const rel = `${w.category}/${w.id}${ext}`;
    fs.mkdirSync(path.join(out, w.category), { recursive: true });
    fs.copyFileSync(staged, path.join(out, ...rel.split('/')));
    icons[w.id] = rel;
  }

  const manifest = {
    version: 1,
    source: `CS2 build ${build || 'unknown'} (${vpk}), extracted ${date}`,
    icons,
  };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log(`Wrote ${Object.keys(icons).length} icons and manifest.json`);
  for (const c of CATEGORIES) {
    const ids = found.filter((w) => w.category === c && icons[w.id]).map((w) => w.id);
    console.log(`  ${c} (${ids.length}): ${ids.join(', ')}`);
  }
  if (missing.length) console.log(`Not in this CS2 build: ${missing.map((w) => `${w.category}/${w.id}`).join(', ')}`);
  if (decodeFailed.length) fail(`Source2Viewer did not produce: ${decodeFailed.map((w) => w.src).join(', ')}`);
}

// run as a script; required (app/src/ui/data/icon-pack.test.ts) it only exposes the ids it extracts
if (require.main === module) main();
module.exports = { wantedIcons };
