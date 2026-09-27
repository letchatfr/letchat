#!/usr/bin/env python3
"""Ajoute une seule fois le script AdSense aux pages HTML de Letchat."""
from pathlib import Path
import re
import sys

CLIENT = 'ca-pub-3317597986908171'
TAG = '<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + CLIENT + '" crossorigin="anonymous"></script>'

root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd()
if not root.is_dir():
    sys.exit(f'Dossier introuvable : {root}')

# Le serveur Express publie public/ ; templates/ contient une copie de la page principale.
paths = [p for folder in ('public', 'templates') for p in (root / folder).rglob('*.html') if p.is_file()]
if not paths:
    sys.exit('Aucune page HTML dans public/ ou templates/. Lancez ce script depuis le dossier du projet.')

for path in sorted(paths):
    html = path.read_text(encoding='utf-8')
    if 'pagead2.googlesyndication.com/pagead/js/adsbygoogle.js' in html:
        print(f'Déjà présent : {path.relative_to(root)}')
        continue
    if not re.search(r'</head\s*>', html, re.I):
        print(f'En-tête absent : {path.relative_to(root)}')
        continue
    updated = re.sub(r'</head\s*>', '  ' + TAG + '\n</head>', html, count=1, flags=re.I)
    path.write_text(updated, encoding='utf-8')
    print(f'Modifié : {path.relative_to(root)}')
