#!/usr/bin/env python3
"""Regenerate ArtemisiaDB.sdf from artemisia.json.

    pip install rdkit
    python3 scripts/build_downloads.py

artemisia.json is the source of truth. After editing it, run this script:
every record's SD properties are rewritten from the JSON and its title line
is set to its ADB ID. Existing 2D coordinates are kept for every record whose
structure has not changed; new records, or records whose SMILES now describe
a different structure, get fresh 2D coordinates from RDKit. A record whose
SMILES RDKit cannot parse keeps its existing structure block and is reported.

Then run scripts/validate.py.
"""

import json
import re
import sys
from pathlib import Path

try:
    from rdkit import Chem, RDLogger
    from rdkit.Chem import AllChem
except ImportError:
    sys.exit("This script needs RDKit: pip install rdkit")

RDLogger.DisableLog("rdApp.*")

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "artemisia.json"
SDF = ROOT / "ArtemisiaDB.sdf"

# SD property names, in order, and the JSON field for each.
PROPERTIES = [
    ("Compound name", "name"),
    ("PubChem ID", "identifier"),
    ("ADB", "adb_id"),
    ("Smiles", "smiles"),
    ("Natural source", "natural_source"),
    ("Total Molweight", "total_molweight"),
    ("cLogP", "clogp"),
    ("cLogS", "clogs"),
    ("H-Acceptors", "h_acceptors"),
    ("H-Donors", "h_donors"),
    ("Polar Surface Area", "polar_surface_area"),
    ("Molecular Formula", "molecular_formula"),
    ("InChI-Key", "inchi_key"),
    ("References", "references"),
]


def existing_blocks():
    """ADB ID -> structure block (up to and including 'M  END') from the current SDF."""
    blocks = {}
    if not SDF.exists():
        return blocks
    for record in re.split(r"^\$\$\$\$\r?\n", SDF.read_bytes().decode("utf-8"), flags=re.M):
        block, sep, data = record.partition("M  END\n")
        m = re.search(r">\s*<ADB>[^\n]*\n([^\r\n]*)", data)
        if sep and m:
            blocks[m.group(1).strip()] = block + sep
    return blocks


def retitle(block, title):
    lines = block.split("\n")
    header = 3 if len(lines) > 3 and ("V3000" in lines[3] or "V2000" in lines[3]) else 2
    # A block whose title line is missing starts one line early; restore it.
    if header == 2:
        lines.insert(0, "")
    lines[0] = title
    return "\n".join(lines)


def skeleton(mol):
    return Chem.MolToInchiKey(mol)[:14] if mol is not None and mol.GetNumAtoms() else None


def main():
    rows = json.loads(DATA.read_text(encoding="utf-8"))
    blocks = existing_blocks()
    out, redrawn, kept_unparsable = [], [], []
    for row in rows:
        cid = row["adb_id"]
        mol = Chem.MolFromSmiles(row["smiles"])
        block = blocks.get(cid)
        if mol is None:
            if block is None:
                sys.exit(f"{cid}: SMILES cannot be parsed and there is no existing structure to keep")
            kept_unparsable.append(cid)
        elif block is None or skeleton(Chem.MolFromMolBlock(block)) != skeleton(mol):
            AllChem.Compute2DCoords(mol)
            block = Chem.MolToMolBlock(mol, forceV3000=True)
            redrawn.append(cid)
        props = "".join(f">  <{name}>\r\n{row[key]}\r\n\r\n" for name, key in PROPERTIES)
        out.append(retitle(block, cid) + props + "$$$$\r\n")
    SDF.write_bytes("".join(out).encode("utf-8"))
    print(f"Wrote {SDF.name}: {len(out)} records; new 2D coordinates for {len(redrawn)}"
          + (f" ({', '.join(redrawn)})" if redrawn else ""))
    if kept_unparsable:
        print(f"  SMILES not parsable, existing structure kept: {', '.join(kept_unparsable)}")
    print("Now run: python3 scripts/validate.py")


if __name__ == "__main__":
    main()
