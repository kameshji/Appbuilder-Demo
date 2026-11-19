#!/usr/bin/env python3
"""Copy the product screenshots the site uses from docs/images into static/assets/shots as WebP.

Run from the website folder:  python3 -I tools/optimise-images.py
Needs Pillow (MIT-CMU licence). Output files are committed, so the normal build does not need Python.
Each screenshot gets two widths (720 and 1440, or the original width if smaller) and a manifest with sizes,
used by the build for width/height attributes (no layout shift).
"""
import json, pathlib, sys
from PIL import Image

HERE = pathlib.Path(__file__).resolve().parent.parent
SRC = HERE.parent / "docs" / "images"
OUT = HERE / "static" / "assets" / "shots"
SHOTS = [
    "table-import-csv", "home-start-with-data", "studio-start-with-data", "studio-filter-formula",
    "preview-checked-out", "studio-button-onselect", "user-mode-tabs", "portal-apps", "portal-tables",
    "roles-who-can-see", "restricted-supervisor-grid", "roles-rule-builder", "roles-test-as-user-why",
    "events-validation-rule", "events-formula-column", "datamodel-canvas", "identity-second-step", "admin-audit",
    "flows-list", "flows-run-detail", "flows-run-history", "reports-builder",
    "core-timeline", "core-tasks", "live-presence-app", "live-notifications", "core-mentions",
    "environments-admin", "solutions-deploy-plan", "backups-list", "backups-restore-dialog", "admin-updates",
    "admin-logs", "setup-admin", "portal-connections",
]
WIDTHS = [720, 1440]
# Crops for places where the whole 1440x900 screen would be too small to read: name -> (source, box)
CROPS = {"studio-filter-formula-crop": ("studio-filter-formula", (0, 0, 1150, 700))}

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for name in SHOTS + list(CROPS):
        srcname, box = CROPS.get(name, (name, None))
        src = SRC / f"{srcname}.png"
        if not src.exists():
            print("missing", src, file=sys.stderr); continue
        im = Image.open(src).convert("RGB")
        if box:
            im = im.crop(box)
        w, h = im.size
        entry = {"w": w, "h": h, "files": {}}
        for tw in WIDTHS:
            tw = min(tw, w) if box is None else min(tw, w)
            tw2 = min(tw, w)
            if str(tw2) in entry["files"]:
                continue
            th = round(h * tw2 / w)
            out = OUT / f"{name}-{tw2}.webp"
            im.resize((tw2, th), Image.LANCZOS).save(out, "WEBP", quality=80, method=6)
            entry["files"][str(tw2)] = out.name
        manifest[name] = entry
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1))
    total = sum(p.stat().st_size for p in OUT.glob("*.webp"))
    print(f"{len(manifest)} screenshots, {total/1024:.0f} KB total")

if __name__ == "__main__":
    main()
