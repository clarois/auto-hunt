#!/usr/bin/env python3
"""Regenerate client/presets.json for auto-hunt from your per-player
skill whitelists (offlineslaveclone-style) + the server's renewal skill_db.yml.

Usage:
  python tools/make_presets.py <conf_skills_dir> <skill_db_yml> [--manual manual_ids.json]

- One .txt per character in conf_skills_dir; one Aegis name per line, # comments ok
  (inline "SKILLNAME # note" lines are also fine — only the first token is read).
- Names are resolved to numeric SKIDs from skill_db.yml (the file the server loads).
  Known misspellings vs your server db are auto-fixed via ALIASES below.
- Names missing from that db (custom plugin skills) get "id": null unless you give
  a manual mapping: {"CHARACTER_NAME": {"AB_SACRAMENT": 91234}, ...} passed via --manual.
  To find your custom skill's ID, search it in the server log or ask your GM;
  rAthena prints "AddSkill ..." lines with the numeric id when skills are granted.

Output overwrites client/presets.json next to this script's parent folder.
Run it any time you add/edit a preset file, then restart the app (client/ layer).
"""
import json
import os
import re
import sys


def resolve_skill_ids(db_path):
    db = open(db_path, encoding='utf-8', errors='replace').read()
    return {m.group(2): int(m.group(1))
            for m in re.finditer(r'-\s*Id:\s*(\d+)\n\s*Name:\s*([A-Z][A-Za-z0-9_\-]+)', db)}


# Known name typos in hand-written preset files vs this server's skill_db.yml.
ALIASES = {
    'AB_SACRAMENT': 'AB_SECRAMENT',   # this server spells it AB_SECRAMENT (id 2515)
}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    manual_path = None
    for i, a in enumerate(sys.argv[1:]):
        if a == '--manual' and i + 1 < len(sys.argv):
            manual_path = sys.argv[i + 1]
    conf_skills_dir, db_path = args[0], args[1]
    ids = resolve_skill_ids(db_path)
    manual = {}
    if manual_path:
        manual = json.load(open(manual_path, encoding='utf-8'))

    presets = {}
    missing = []
    for fn in sorted(os.listdir(conf_skills_dir)):
        if not fn.endswith('.txt'):
            continue
        char = fn[:-4]
        skills, seen = [], set()
        for line in open(os.path.join(conf_skills_dir, fn), encoding='utf-8', errors='replace'):
            m = re.match(r'\s*([A-Z][A-Za-z0-9_\-]+)', line)
            if not m:
                continue
            name = ALIASES.get(m.group(1), m.group(1))
            if name in seen:  # first occurrence wins; file order is preserved
                continue
            seen.add(name)
            sid = ids.get(name, manual.get(char, {}).get(name))
            skills.append({'name': name, 'id': sid})
            if sid is None:
                missing.append((char, name))
        presets[char] = skills

    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'client')
    out_path = os.path.normpath(os.path.join(out_dir, 'presets.json'))
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(presets, f, indent=1)

    for char in sorted(presets):
        valid = [s for s in presets[char] if s['id']]
        nulls = [s['name'] for s in presets[char] if not s['id']]
        print(f'{char}: {len(valid)} resolvable skill(s)' + (f' | unresolved: {", ".join(nulls)}' if nulls else ''))
    if missing:
        print('UNRESOLVED (need --manual mapping or fix the name):')
        for char, name in missing:
            print(f'  {char}: {name}')


if __name__ == '__main__':
    main()
