"""Verify upstream Agency source-to-Codex conversion and optional installed copies."""
import argparse
import hashlib
import json
import re
from pathlib import Path
import toml
import yaml

parser = argparse.ArgumentParser()
parser.add_argument('--source', required=True)
parser.add_argument('--installed')
parser.add_argument('--manifest', required=True)
args = parser.parse_args()
root = Path(args.source)
divisions = json.loads((root / 'divisions.json').read_text(encoding='utf-8'))['divisions']
generated = root / 'integrations/codex/agents'
expected = {}
for division in divisions:
    for source in (root / division).rglob('*.md'):
        text = source.read_text(encoding='utf-8')
        if not text.startswith('---\n'):
            continue
        match = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
        assert match, 'Invalid frontmatter: ' + str(source)
        meta = yaml.safe_load(match.group(1))
        name, description = meta['name'], meta['description']
        slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
        filename = slug + '.toml'
        assert filename not in expected, 'Duplicate role: ' + filename
        artifact = generated / filename
        data = toml.loads(artifact.read_text(encoding='utf-8'))
        assert set(data) == {'name', 'description', 'developer_instructions'}, filename
        assert data['name'] == name, 'Name mismatch: ' + filename
        assert data['description'] == description, 'Description mismatch: ' + filename
        assert data['developer_instructions'] == match.group(2).rstrip('\n'), 'Body mismatch: ' + filename
        digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
        if args.installed:
            installed = Path(args.installed) / filename
            assert hashlib.sha256(installed.read_bytes()).hexdigest() == digest, 'Installed hash mismatch: ' + filename
        expected[filename] = {'source': source.relative_to(root).as_posix(), 'name': name, 'sha256': digest}
assert set(expected) == {p.name for p in generated.glob('*.toml')}, 'Missing or extra generated roles'
manifest = {'count': len(expected), 'divisions': len(divisions), 'roles': dict(sorted(expected.items()))}
Path(args.manifest).write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('PASS: {} roles, {} divisions; names, descriptions, bodies and TOML fields match sources{}'.format(len(expected), len(divisions), '; installed hashes match' if args.installed else ''))
