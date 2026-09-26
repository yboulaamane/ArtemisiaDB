# ArtemisiaDB
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/yboulaamane/ArtemisiaDB/main/assets/brand/logo-dark.svg">
  <img src="assets/brand/logo.svg" alt="ArtemisiaDB" height="96">
</picture>

*A curated database containing chemical information of secondary metabolites isolated from* Artemisia *L. species.*

Artemisia is a large, diverse genus of small herbs and shrubs with between 200 and 400 species belonging to the Asteraceae family. Due to the wide spectrum of pharmacological activities owing to the presence of several secondary metabolites, Artemisia has been used as traditional medicine since ancient times as an anthelmintic, antispasmodic, antirheumatic, and antibacterial agent and for the treatment of malaria, hepatitis, cancer, inflammation, and menstrual-related disorders. Recently, its extracts displayed promising antiviral properties against Covid-19. To help accelerate drug discovery, ArtemisiaDB was created to serve as an additional asset for high-throughput virtual screening campaigns.

**Browse it online:** https://yboulaamane.github.io/ArtemisiaDB/

The website lets you search every field, filter by plant, molecular weight, cLogP, TPSA and Lipinski's rule of five, sort any column, see each 2D structure, open a compound's full record with links to PubChem, ChemSpider, CAS, DOI and PubMed, and export the filtered records as CSV or SMILES. Filters are kept in the URL, and `#ADB001` opens that record.

## Files

| File | Contents |
|---|---|
| `artemisia.json` | The database. The website reads this file directly. |
| `ArtemisiaDB.sdf` | 2D structures with all fields as SD properties |
| `index.html`, `assets/` | The website |
| `scripts/build_downloads.py` | Regenerates the SDF from `artemisia.json` |
| `scripts/validate.py` | Consistency checks for the JSON and the SDF |
| `assets/brand/` | Logo, icon and social preview image |

Each record links one compound to one *Artemisia* species, so a compound reported from several species appears once per species. Fields, all stored as text:

| Field | Meaning |
|---|---|
| `adb_id` | ArtemisiaDB identifier, for example `ADB001` |
| `name` | Compound name |
| `identifier` | External identifier: `CID:` (PubChem), `CHEMSPIDER:` or `CASID:` |
| `smiles` | SMILES |
| `natural_source` | *Artemisia* species the compound was reported from |
| `total_molweight` | Molecular weight (g/mol) |
| `clogp`, `clogs` | Calculated logP and log solubility |
| `h_acceptors`, `h_donors` | Hydrogen-bond acceptors and donors |
| `polar_surface_area` | Polar surface area (Å²) |
| `molecular_formula` | Molecular formula |
| `inchi_key` | InChIKey |
| `references` | Sources: `DOI:`, `PMID:` or `ISBN:`, comma-separated |

## Updating the data

1. Edit `artemisia.json`. The website picks up the change on the next page load.
2. Regenerate the SDF (needs [RDKit](https://www.rdkit.org)):

   ```bash
   pip install rdkit
   python3 scripts/build_downloads.py
   ```

3. Run the checks:

   ```bash
   python3 scripts/validate.py
   ```

   Errors exit with status 1; warnings are curation notes. With RDKit installed it also checks every SMILES against its InChIKey. The same check runs on GitHub for every push and pull request.

To preview the website locally, serve the folder over HTTP (`python3 -m http.server 8000`, then open http://localhost:8000); opening `index.html` straight from disk does not work.

