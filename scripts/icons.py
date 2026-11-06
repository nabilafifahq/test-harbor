import sys, json
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
f = TTFont(sys.argv[1])
names = sys.argv[2].split(',')
gs = f.getGlyphSet(); order = set(f.getGlyphOrder())
cmap = f.getBestCmap()
# ligature lookup: map icon name -> glyph via GSUB ligatures
lig = {}
for lookup in f['GSUB'].table.LookupList.Lookup:
    for st in lookup.SubTable:
        t = getattr(st, 'ExtSubTable', st)
        if hasattr(t, 'ligatures'):
            for first, ligs in t.ligatures.items():
                for l in ligs:
                    comps = [first] + l.Component
                    lig[tuple(comps)] = l.LigGlyph
rev = {v: k for k, v in cmap.items()}
def glyph_for(name):
    if name in order: return name
    comps = tuple(cmap.get(ord(c)) for c in name)
    return lig.get(comps)
upm = f['head'].unitsPerEm
out = {}
for n in names:
    g = glyph_for(n)
    if not g: out[n] = None; continue
    pen = SVGPathPen(gs)
    # flip y: font units -> svg
    tp = TransformPen(pen, (1, 0, 0, -1, 0, upm * 0.875 if False else f['hhea'].ascent))
    gs[g].draw(tp)
    out[n] = pen.getCommands()
print(json.dumps({'upm': upm, 'ascent': f['hhea'].ascent, 'descent': f['hhea'].descent, 'icons': {k: (v[:60] + '...') if v else None for k, v in out.items()}}))
json.dump({'upm': upm, 'ascent': f['hhea'].ascent, 'descent': f['hhea'].descent, 'icons': out}, open(sys.argv[3], 'w'))
