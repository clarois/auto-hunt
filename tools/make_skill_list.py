#!/usr/bin/env python3
"""Build client/skill-list.json — EVERY learnable skill on this server, grouped by job tree (base + jobs 1-4).

Usage:
    python tools\\make_skill_list.py "<skill_db.yml>" [output.json]

Default output: client/skill-list.json next to the mod's client folder.

The list is a REFERENCE for copying entries into presets.json — only {name, id} matter there.
Grouping was derived from this server's own rAthena skill factory sources (each skill's owning
lineage family) plus standard RO Renewal class naming; shared-prefix skills land in their tree
with a per-class note. The server silently ignores any entry your character hasn't learned, so
copy-pasting extra lines is harmless — worst case that line just does nothing in game.
"""
import json
import re
import sys

# prefix -> group label. Derived from this server's skills/<family> factories + standard RO Renewal classes.
GROUPS = {
    # Base
    "NV":  ("01) Base — Novice basics (every job)", 1),
    "AL":  ("02) Base — basic spells everyone can learn (heal, warp, teleport...)", 2),
    "ALL": ("03) Special — global actives available to any job", 3),

    # Job 1
    "SM":  ("Job 1 — Swordsman (weapon mastery + bash/provoke/recovery)", 10),
    "AC":  ("Job 1 — Archer", 11),
    "MC":  ("Job 1-2 — Merchant line basics (vending, cart, MAMMONITE...)", 12),
    "AM":  ("Job 1-2 — shared axe mastery / potion research skills", 13),
    "TF":  ("Job 1 — Thief", 14),
    "TK":  ("Job 1 — Taekwon (running, kicks, counter)", 15),

    # Job 2+ swordsman tree
    "KN":  ("Job 2-3 — Knight / Crusader spear & shield skills", 20),
    "CR":  ("Job 2/3 — Crusader shared (devotion, grand cross, shield press...)", 21),
    "IG":  ("Job 2/3 — Crusador/Knight guard & stance skills", 22),
    "DK":  ("Job 3/4 — Dragon Knight / Lord Knight servant-weapon & dragonic line", 23),
    "RK":  ("Job 3/4 — dragon training/breath, windcutter (DK tree)", 24),
    "LG":  ("Job 3/4 — DK/LK spear skills (cannon spear, pinpoint attack...)", 25),
    "LK":  ("Job 4 — Lord Knight / Black Night melee", 26),
    "PA":  ("Job 2-4 — Paladin/Crusador line (gloria domini, battle chant, shield chain)", 27),

    # Job 2+ archer tree
    "HT":  ("Archer tree — hunter traps shared across jobs", 30),
    "RA":  ("Job 3/4 — Ranger / Windhawk line (aimed bolt, arrow storm...)", 31),
    "SN":  ("Job 3/4 — Ranger sniper line (falcon assault, sight, wind walk)", 32),
    "WH":  ("Job 2-4 — archer tree hawk skills (hawk rush, calamity gale...)", 33),
    "BA":  ("Job 2+ — Bard music (lesson, dissonance, poem of Bragi...)", 34),
    "BD":  ("Job 2+ — Dancer dance (encore, lullaby, rich man's kimono...)", 35),
    "WA":  ("Job 2+ — bard/dancer shared music skills", 36),
    "WM":  ("Job 2+ — dancer song line (metallic sound, voice of siren...)", 37),
    "CG":  ("Job 3/4 — Maestro / Wanderer (tarot card, special singer...)", 38),

    # Mage tree
    "MG":  ("Mage tree — wizard general (sight, napalm beat, cold bolt...)", 40),
    "EM":  ("Mage tree — elemental & arcane magic shared by mages/sages", 41),
    "EL":  ("Job 3/4 — Sage/elemental magic circles & cloaks", 42),
    "WZ":  ("Job 3/4 — sage/general spell line (fire pillar, meteor...)", 43),
    "WL":  ("Job 3/4 — wizard/sage elemental line (jack frost, white imprisonment...)", 44),
    "HW":  ("Job 3/4 — high-wizard arcane line (soul drain, magic crasher...)", 45),
    "PF":  ("Job 3/4 — warlock/sorcerer line (memorize, fog wall, mind breaker...)", 46),
    "SO":  ("Job 2-4 — spellfist & walking auras shared by mage jobs", 47),
    "AG":  ("Job 2-3 — Archer->Arch Mage crystal/agility line (deadly projection, soul VC strike...)", 48),

    # Summoner / Soul Linker tree
    "SA":  ("Job 3/4 — Summoner (advanced book, autocast, flame/frost launcher...)", 50),
    "SH":  ("Monk/Champion/Sura tree — mystical creature summoning", 51),
    "SU":  ("Job 2-4 — Sura line basic & power skills", 52),
    "SB":  ("Job 3/4 — Sura shadow-blade arts", 53),
    "ST":  ("Job 3/4 — Sura chase-walk/full-strip/sword-reject", 54),

    # Acolyte / Monk tree
    "PR":  ("Acolyte/Priest line (mace mastery, sanctury, aspersio...)", 60),
    "HP":  ("Job 2 — High Priest (assumptio, basilica, meditation...)", 61),
    "AB":  ("Custom class — Arch Bishop", 62),
    "IQ":  ("Custom class — Cardinal (faith & judgement spells)", 63),
    "CD":  ("Custom class — Acolyte/Cardinal shared family (reparatio, argutus...)", 64),
    "CH":  ("Job 1-3 — Champion/Monk line (palm strike, chain crush, soul collect)", 65),
    "MO":  ("Monk/Champion/Sura tree — spirit sphere summoning", 66),
    "SR":  ("Job 2-4 — Champion skill set (dragon combo, fallen empire...)", 67),

    # Thief cross tree
    "RG":  ("Job 1-3 — Rogue line shared (snatcher, raid, tunnel drive, strips...)", 70),
    "SC":  ("Job 2/3 — Shadow Cross", 71),
    "SHC": ("Job 3/4 — Shadow Cross exceed / shadow-chaser arts", 72),
    "AS":  ("Job 2-4 — Assassin/Cross line shared (sonic blow, cloak, poison...)", 73),
    "ASC": ("Assassin cross exceed family", 74),
    "GC":  ("Job 2-4 — Guillotine Cross (venom, cross impact, antidote...)", 75),
    "ABC": ("Custom class — abyss/dagger-bow assassin family", 76),

    # Ninja tree
    "NJ":  ("Ninja/Kagerou/Oboro tree — kunai, shadow jump...", 80),
    "KO":  ("Ninja tree Job 2+ (kagehumi-adjacent strikes)", 81),
    "KG":  ("Ninja tree — kage arts", 82),
    "SS":  ("Ninja tree Job 3/4 (shadow techniques)", 83),
    "OB":  ("Ninja tree Job 3/4 (oboro arts)", 84),

    # Gunslinger / custom
    "GS":  ("Gunslinger/Rebellion line — marksmanship & fling", 90),
    "NW":  ("Gunslinger/Rebellion line — grenade & advanced shooting", 91),
    "RL":  ("Gunslinger/Rebellion line — ricolet & burst skills", 92),

    # Mercenary Fighter tree (this server adds MA/MER/ML/MS under it)
    "MA":  ("Job 2-4 — archer-tree general ranged skills (double shot, skid trap...)", 39),
    "MER": ("Mercenary tree — mercenary general mastery skills", 116),
    "ML":  ("Mercenary tree — melee spear/mastery line", 117),
    "MS":  ("Mercenary tree — shared melee skills (bash, magnum, parrying...)", 118),

    # Bard/Dancer extra roots seen on this server
    "TR":  ("Job 2+ — Troubadour/Trouvere music line (stage manner, mystic symphony...) TR_ prefix", 34),
    "MI":  ("Job 2-4 — bard/dancer shared instrument skills (windmill rush...)", 35),
    "DC":  ("Job 2+ — Dancer/Gypsy line (scream, humming, fortune kiss...) DC_ prefix", 36),
    "SJ":  ("Taekwon tree Job 2/3 — Stargladiator (light of moon/star, fullmoon kick...)", 100),
    "SKE": ("Taekwon tree Job 3+ — Stargladiator advanced (rising sun/moon, dawn break...)", 101),
    "SG":  ("Taekwon/Stargladiator line — feeling/warmth of sun moon stars", 102),
    "SL":  ("Soul Linker tree — spirit links to job skills (spirit of knight/sage...)", 103),
    "SOA": ("Stargladiator/Soul Linker shared talisman & soul arts", 104),
    "SP":  ("Taekwon/Stargladiator line — summon/goem souls", 105),

    # Merchant full tree (smithing, mechanics)
    "BS":  ("Merchant tree — Blacksmith tempering/enchant skills", 110),
    "WS":  ("Merchant tree Job 2-4 — Mastersmith/Meister system & coin/nugget forging", 111),
    "GN":  ("Job 2-3 — Guild Merchant cart & trap skills", 112),
    "GD":  ("Job 3/4 — guild guard / kafra contract (Guild Merchant tree) GD_ prefix", 119),
    "MT":  ("Job 3/4 — Mechanic line (machines, axe stomp...)", 113),
    "NC":  ("Job 3/4 — Mechanic cannons/scanners/vulcan arm", 114),
    "BO":  ("Custom class — biolab/gene family (bionic pharmacy...)", 115),

    # Homunculus / system / npc / custom system skills
    "HAMI": ("Homunculus/system line (castle, bloodlust...)", 200),
    "HN":   ("Super Novice tree — basic job skills available to all SNO/Expanded characters", 204),
    "GM":   ("System/custom — GM sandman & similar utility skills", 210),
    "ECL":  ("Custom/system — Eclage-related line (snow flip, peony mama...)", 211),
    "ECLAGE":("Custom/system — Eclage recall system skill", 212),
    "RETURN":("System — return-to-map utility skills (not learnable by normal characters)", 213),
    "CASH": ("Cash-shop item skills (party blessing, inccarry, assumptio) — usable on this server", 214),
    "ABR":  ("Custom class — battle-buster / dual-cannon family (merchant-tree source)", 215),
    "HFLI": ("Homunculus flight/leveling line HFLI_", 216),
    "ITEM": ("Item-usage skill entries (weapon enchantment...) — listed for completeness", 217),
    "ITM":  ("Item/special skills (throw tomahawk) — server-added", 218),
    "HLIF": ("Homunculus life/avoid line", 201),
    "HVAN": ("Homunculus van line (caprice, chaos, instruct, explosion)", 202),
    "MH":   ("Homunculus mastery & creature skills", 203),
    "WE":   ("Wedding/family system skills (not for hunting)", 210),
    "NPC":  ("NPC/system skills — not learnable by normal characters; listed only for completeness", 220),
}

# roots seen on this server but with no explicit group: send to catch-all, never lost.
CATCHALL = ("Unassigned — search this group (Ctrl+F the skill name in your editor)", 99)


def group_for(name):
    root = name.split("_", 1)[0]
    g = GROUPS.get(root)
    return g if g else CATCHALL


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    yml_path = sys.argv[1]
    out_path = sys.argv[2] if len(sys.argv) > 2 else "client/skill-list.json"

    data = open(yml_path, encoding="utf-8", errors="replace").read()

    skills_by_id = {}
    for m in re.finditer(
        r"^\s+-\s+Id:\s+(\d+)\n\s*Name:\s+(\w+)\n(.*?)(?=^\s+-\s+Id:\s|\Z)",
        data, re.M | re.S):
        sid = int(m.group(1))
        name = m.group(2)
        body = m.group(3)
        tm = re.search(r"^\s*Type:\s*(\w+)\n", body, re.M)
        dm = re.search(r"^\s*Description:\s*(.+)\n", body, re.M)
        skills_by_id[sid] = {
            "name": name,
            "id": sid,
            "type": tm.group(1) if tm else "",
            "desc": dm.group(1).strip() if dm else "",
        }

    grouped = {}
    for s in skills_by_id.values():
        label, order = group_for(s["name"])
        grouped.setdefault((order, label), []).append(s)

    ordered_keys = sorted(grouped.keys())
    result = {
        "_comment": (
            "REFERENCE list of every learnable skill on this server, grouped by job tree. "
            "NOT a loadout — copy only the lines your character actually uses."
        ),
        "_usage": (
            "1) Find your class in the groups below (or Ctrl+F for a skill name). "
            "2) Paste them INTO client/presets.json under YOUR character name (whole entry, as-is):\n"
            '   "mara": [ {"name":"AB_CANTO","id":2042}, {"name":"CD_REPARATIO","id":5268} ].\n'
            "You can paste WHOLE entries from this file as-is — extra fields (type/desc) are fine; "
            "presets.json reads only name+id. The server itself only honors skills your character "
            "has learned, so unlearned lines are skipped harmlessly."
        ),
        "_total_skills": len(skills_by_id),
        "groups": [
            {"label": label, "skills": sorted(grouped[(order, label)], key=lambda s: s["name"])}
            for (order, label) in ordered_keys
        ],
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)
    print(f"wrote {out_path}: {len(skills_by_id)} skills across {len(ordered_keys)} groups")
    for (order, label) in ordered_keys:
        n = len(grouped[(order, label)])
        print(f"  [{label}] -> {n}")


if __name__ == "__main__":
    main()
