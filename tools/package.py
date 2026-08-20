#!/usr/bin/env python3
"""Build a Chrome Web Store upload zip containing only what ships.

    python3 tools/package.py            # -> dist/subscrub-1.0.0.zip
    python3 tools/package.py --bump     # patch-bump manifest version, then build

Dev files (test/, tools/, .claude/, README, dotfiles) are left out: the store
review looks at everything you upload, so shipping less is simply faster.
"""
import argparse
import json
import os
import sys
import zipfile

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
SHIP = ['manifest.json', 'src', 'icons']          # everything the extension needs at runtime
SKIP_NAMES = {'.DS_Store'}
MAX_ZIP_MB = 10                                    # store hard limit is much higher; this is a smell check


def fail(msg):
    print('error: ' + msg, file=sys.stderr)
    sys.exit(1)


def load_manifest():
    path = os.path.join(ROOT, 'manifest.json')
    if not os.path.exists(path):
        fail('no manifest.json at ' + ROOT)
    with open(path) as fh:
        return json.load(fh), path


def bump_version(manifest, path):
    parts = manifest['version'].split('.')
    parts[-1] = str(int(parts[-1]) + 1)
    manifest['version'] = '.'.join(parts)
    with open(path) as fh:
        raw = fh.read()
    old = '"version": "%s"' % '.'.join(parts[:-1] + [str(int(parts[-1]) - 1)])
    raw = raw.replace(old, '"version": "%s"' % manifest['version'], 1)
    with open(path, 'w') as fh:
        fh.write(raw)
    print('version -> ' + manifest['version'])
    return manifest


def check(manifest):
    """Catch the mistakes that get an upload rejected before you upload it."""
    problems = []

    if manifest.get('manifest_version') != 3:
        problems.append('manifest_version must be 3 (MV2 is no longer accepted)')

    version = manifest.get('version', '')
    if not all(p.isdigit() and (p == '0' or not p.startswith('0')) for p in version.split('.')):
        problems.append('version %r must be 1-4 dot-separated integers' % version)

    if len(manifest.get('description', '')) > 132:
        problems.append('description is over the 132-character store limit')

    # Every file the manifest points at must exist in the zip.
    referenced = list(manifest.get('icons', {}).values())
    referenced += list(manifest.get('action', {}).get('default_icon', {}).values())
    if manifest.get('action', {}).get('default_popup'):
        referenced.append(manifest['action']['default_popup'])
    if manifest.get('options_page'):
        referenced.append(manifest['options_page'])
    if manifest.get('background', {}).get('service_worker'):
        referenced.append(manifest['background']['service_worker'])
    for entry in manifest.get('content_scripts', []):
        referenced += entry.get('js', []) + entry.get('css', [])
    for rel in referenced:
        if not os.path.exists(os.path.join(ROOT, rel)):
            problems.append('manifest references missing file: ' + rel)

    if '128' not in manifest.get('icons', {}):
        problems.append('a 128x128 icon is required for the store listing')

    return problems


def collect():
    files = []
    for entry in SHIP:
        path = os.path.join(ROOT, entry)
        if not os.path.exists(path):
            fail('missing ' + entry)
        if os.path.isfile(path):
            files.append(entry)
            continue
        for dirpath, _dirs, names in os.walk(path):
            for name in sorted(names):
                if name in SKIP_NAMES:
                    continue
                full = os.path.join(dirpath, name)
                files.append(os.path.relpath(full, ROOT))
    return sorted(files)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bump', action='store_true', help='patch-bump the manifest version first')
    args = ap.parse_args()

    manifest, manifest_path = load_manifest()
    if args.bump:
        manifest = bump_version(manifest, manifest_path)

    problems = check(manifest)
    if problems:
        for p in problems:
            print('  ✗ ' + p, file=sys.stderr)
        fail('%d problem(s) — fix before uploading' % len(problems))

    files = collect()
    out_dir = os.path.join(ROOT, 'dist')
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, 'subscrub-%s.zip' % manifest['version'])

    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
        for rel in files:
            zf.write(os.path.join(ROOT, rel), rel)

    size_mb = os.path.getsize(out) / 1024 / 1024
    print('\n%s  (%d files, %.1f KB)' % (os.path.relpath(out, ROOT), len(files), size_mb * 1024))
    for rel in files:
        print('  ' + rel)
    if size_mb > MAX_ZIP_MB:
        print('\nwarning: %.1f MB is large for this extension — check for stray files' % size_mb)
    print('\nUpload at https://chrome.google.com/webstore/devconsole')


if __name__ == '__main__':
    main()
