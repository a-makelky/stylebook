#!/usr/bin/env python3
# Generates the Stylebook nib-mark icons into design/icons/.
# Run: python3 design/make-icons.py
#
# Each stroke is drawn six times along a short diagonal, the edge of a
# broad-nib pen, so lines swell and thin with direction the way the italic
# wordmark does. The small set uses a narrower nib for 16 to 20px.
import os, sys
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
NIB = [(-0.8, 0.6), (-0.48, 0.36), (-0.16, 0.12), (0.16, -0.12), (0.48, -0.36), (0.8, -0.6)]
SMALL = [(x * 0.6, y * 0.6) for x, y in NIB]

ICONS = {
  "library":    {"d": "M4.5 10C8.5 8.4 12.3 8.8 16 11.2C19.7 8.8 23.5 8.4 27.5 10V23C23.5 21.4 19.7 21.8 16 24.2C12.3 21.8 8.5 21.4 4.5 23V10ZM16 11.2V24.2"},
  "suggestion": {"d": "M10.5 8H21.5M7.5 25L16 13L24.5 25"},
  "edition":    {"d": "M7.5 10.5H20.5V26.5H7.5V10.5ZM11.5 6.5H24.5V22.5"},
  "publish":    {"d": "M5.5 17.5C8 19 10 21.4 11.6 24.6C15 16.6 19.8 10.2 26.8 6"},
  "decline":    {"d": "M6.5 22C12.3 20 17.8 15.2 20.8 9.8C22 7.6 21.4 5.5 19.7 5.5C17.6 5.5 16.7 8.5 18.2 11.7C19.5 14.5 22.3 16.3 25.5 16.5"},
  "combine":    {"d": "M5.5 12.5C11.2 6.8 20.8 6.8 26.5 12.5M5.5 19.5C11.2 25.2 20.8 25.2 26.5 19.5"},
  "history":    {"d": "M9.8 9.4C13.8 5.3 20.3 5.4 24 9.6C27.7 13.8 27.3 20.3 23 23.9C18.8 27.4 12.5 27 8.8 22.9C7.3 21.2 6.5 19.2 6.3 17.2M10 4.2L9.6 9.7L15 10"},
  "locked":     {"d": "M5.5 13H26.5", "dots": [(7.5, 20.5), (12, 20.5), (16.5, 20.5), (21, 20.5), (25.5, 20.5)]},
}

def svg(name, spec, nib, width):
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="{width}" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="{name.capitalize()}">']
    for dx, dy in nib:
        parts.append(f'<path transform="translate({dx:g} {dy:g})" d="{spec["d"]}"/>')
    for cx, cy in spec.get("dots", []):
        parts.append(f'<circle cx="{cx:g}" cy="{cy:g}" r="1.15" fill="currentColor" stroke="none"/>')
    parts.append("</svg>")
    return "\n".join(parts) + "\n"

os.makedirs(os.path.join(OUT, "small"), exist_ok=True)
for name, spec in ICONS.items():
    open(os.path.join(OUT, f"{name}.svg"), "w").write(svg(name, spec, NIB, 0.9))
    open(os.path.join(OUT, "small", f"{name}.svg"), "w").write(svg(name, spec, SMALL, 1.0))
print("wrote", len(ICONS) * 2, "files")
