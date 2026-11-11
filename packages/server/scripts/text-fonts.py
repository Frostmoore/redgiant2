"""The fonts of the picture editor's text layers (p3.5.8), made once and carried in
packages/server/fonts. Lato and Liberation Serif/Mono (Reserved Font Names) are copied as they
are. The others become static TrueType files (a variable font is cut at its regular and bold
weights, its italic from its own italic file: never synthesized), subset to Latin (Basic Latin,
Latin-1, Latin Extended-A and -B, common punctuation, the euro), without hinting and without
layout tables (the renderer places glyphs by their advances, the page's text area turns kerning
and ligatures off). The page and the server draw with these very files.

Dev only: python -I text-fonts.py <sources> <out>, with fontTools installed. <sources> holds the
google/fonts folders (ofl/<family>/…, each with its OFL.txt) and liberation/ (the Liberation
2.1.5 TTF release). Liberation Sans itself comes from pdf.js (pdfjs-dist/standard_fonts).
"""

import shutil
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

UNICODES = (
    list(range(0x20, 0x7F))
    + list(range(0xA0, 0x250))
    + [0x2C6, 0x2C7, 0x2D8, 0x2D9, 0x2DA, 0x2DB, 0x2DC, 0x2DD]
    + list(range(0x2010, 0x2028))
    + list(range(0x2030, 0x203B))
    + [0x2044, 0x20AC, 0x2122, 0x2212]
)

# family id -> (folder, output stem, {style: source file})
VARIABLE = {
    "inter": ("inter", "Inter", "Inter[opsz,wght].ttf", "Inter-Italic[opsz,wght].ttf"),
    "roboto": ("roboto", "Roboto", "Roboto[wdth,wght].ttf", "Roboto-Italic[wdth,wght].ttf"),
    "noto-sans": (
        "notosans",
        "NotoSans",
        "NotoSans[wdth,wght].ttf",
        "NotoSans-Italic[wdth,wght].ttf",
    ),
    "noto-serif": (
        "notoserif",
        "NotoSerif",
        "NotoSerif[wdth,wght].ttf",
        "NotoSerif-Italic[wdth,wght].ttf",
    ),
    "montserrat": (
        "montserrat",
        "Montserrat",
        "Montserrat[wght].ttf",
        "Montserrat-Italic[wght].ttf",
    ),
    "open-sans": (
        "opensans",
        "OpenSans",
        "OpenSans[wdth,wght].ttf",
        "OpenSans-Italic[wdth,wght].ttf",
    ),
}
STATIC = {
    "lato": (
        "lato",
        "Lato",
        {
            "Regular": "Lato-Regular.ttf",
            "Bold": "Lato-Bold.ttf",
            "Italic": "Lato-Italic.ttf",
            "BoldItalic": "Lato-BoldItalic.ttf",
        },
    ),
}
LIBERATION = ["Serif", "Mono"]
STYLES = ["Regular", "Bold", "Italic", "BoldItalic"]


def pin(font: TTFont, weight: int) -> TTFont:
    """A static instance of a variable font at a weight (other axes at their defaults)."""
    axes = {a.axisTag: a.defaultValue for a in font["fvar"].axes}
    axes["wght"] = weight
    if "opsz" in axes:
        # Inter: the text optical size.
        axes["opsz"] = 14 if 14 >= min_of(font, "opsz") else axes["opsz"]
    return instancer.instantiateVariableFont(font, axes, updateFontNames=True)


def min_of(font: TTFont, tag: str) -> float:
    return next(a.minValue for a in font["fvar"].axes if a.axisTag == tag)


def save_subset(font: TTFont, out: Path) -> None:
    opts = subset.Options()
    opts.layout_features = []
    opts.hinting = False
    opts.drop_tables += ["GSUB", "GPOS", "GDEF", "kern", "STAT", "DSIG", "MVAR", "HVAR"]
    opts.name_IDs = ["*"]
    opts.notdef_outline = True
    opts.glyph_names = False
    s = subset.Subsetter(opts)
    s.populate(unicodes=UNICODES)
    s.subset(font)
    font.save(out)


def main(src: Path, out: Path) -> None:
    # Fonts with a Reserved Font Name (Lato, Liberation) are carried unmodified: the OFL forbids
    # that name on a modified version, and a subset is one. Source Code Pro (Reserved Font Name
    # «Source») is not carried: only its variable file was at hand, and a static instance of it
    # would be a modified version.
    out.mkdir(parents=True, exist_ok=True)
    for _, (folder, stem, upright, italic) in VARIABLE.items():
        for style in STYLES:
            source = italic if "Italic" in style else upright
            f = pin(TTFont(src / folder / source), 700 if "Bold" in style else 400)
            save_subset(f, out / f"{stem}-{style}.ttf")
        shutil.copy(src / folder / "OFL.txt", out / f"OFL-{stem}.txt")
    for _, (folder, stem, files) in STATIC.items():
        for style, file in files.items():
            shutil.copy(src / folder / file, out / f"{stem}-{style}.ttf")
        shutil.copy(src / folder / "OFL.txt", out / f"OFL-{stem}.txt")
    lib = next((src / "liberation").glob("liberation-fonts-ttf-*"))
    for family in LIBERATION:
        for style in STYLES:
            name = f"Liberation{family}-{style}.ttf"
            shutil.copy(lib / name, out / name)
    shutil.copy(lib / "LICENSE", out / "OFL-Liberation.txt")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
