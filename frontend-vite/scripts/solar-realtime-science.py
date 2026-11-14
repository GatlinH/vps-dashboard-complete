import argparse
import datetime as dt
import gzip
import hashlib
import json
import re
from pathlib import Path

import spiceypy as spice

SOURCE_PINS = {'bsp': 'c1c7feeab882263fc493a9d5a5b2ddd71b54826cdf65d8d17a76126b260a49f2', 'lsk': '678e32bdb5a744117a467cd9601cd6b373f0e9bc9bbde1371d5eee39600a039b'}
HALLEY_PINS = ['15cd88c478ecf74094dee62bc3ada8bb49d36f7a4372b1ac895f1106a1e8188a', '4f3da79bc5d8ae599025eb45c958ea8b40912f088b0a359e87498a294f81f883', '30248bcfb54fbb4f7bcc1463f7e41a15577806aaaba0732cb0712c42c0ae1c8c', 'fa2ba7251351a47aabdb9908d7b76177fdb3129ec0aab871596124953c1a1795', 'a95b73252c811cc298663e59cd79886af95f5b7486d1f38e5922c4f02ad93ae9']


def read_original_halley(directory):
    files = sorted(Path(directory).glob('halley-*.txt.gz'))
    if [p.name for p in files] != [f'halley-{i}.txt.gz' for i in range(5)]:
        raise ValueError('SCI_ORIGINAL_ARCHIVE_SET')
    pattern = re.compile(r'([0-9]+\.[0-9]+) =[^\n]*\n\s*X\s*=\s*([-+0-9.E]+)\s+Y\s*=\s*([-+0-9.E]+)\s+Z\s*=\s*([-+0-9.E]+)\s*\n\s*VX\s*=\s*([-+0-9.E]+)\s+VY\s*=\s*([-+0-9.E]+)\s+VZ\s*=\s*([-+0-9.E]+)')
    by_jd, archives, overlaps = {}, [], []
    raw_rows = 0
    for index, path in enumerate(files):
        blob = path.read_bytes()
        digest = hashlib.sha256(blob).hexdigest()
        if digest != HALLEY_PINS[index]:
            raise ValueError('SCI_ORIGINAL_ARCHIVE_HASH')
        text = gzip.decompress(blob).decode('utf8')
        for clause in ['{source: JPL#75}', '{source: DE441}', '{source: SB441-N16}', 'Ecliptic of J2000.0', 'GEOMETRIC cartesian states', 'AU-D', ' TDB']:
            if clause not in text:
                raise ValueError(f'SCI_ORIGINAL_CONVENTION {clause}')
        body = text.split('$$SOE')[1].split('$$EOE')[0]
        rows = pattern.findall(body)
        if not rows:
            raise ValueError('SCI_ORIGINAL_ROWS_REQUIRED')
        for columns in rows:
            row = {'jdTdb': float(columns[0]), 'position': list(map(float, columns[1:4])), 'velocity': list(map(float, columns[4:7])), 'archive': index}
            previous = by_jd.get(row['jdTdb'])
            if previous:
                difference = sum((a - b) ** 2 for a, b in zip(previous['position'], row['position'])) ** 0.5
                overlaps.append({'jdTdb': row['jdTdb'], 'archives': [previous['archive'], index], 'originalPositions': [previous['position'], row['position']], 'positionDifferenceAu': difference, 'policy': 'retain later original row; never average or edit original'})
            by_jd[row['jdTdb']] = row
        raw_rows += len(rows)
        archives.append({'path': path.name, 'sha256': digest, 'bytes': len(blob), 'rows': len(rows)})
    rows = [by_jd[jd] for jd in sorted(by_jd)]
    if raw_rows != 73055 or len(rows) != 73051 or rows[0]['jdTdb'] != 2415020.5 or rows[-1]['jdTdb'] != 2488070.5:
        raise ValueError('SCI_ORIGINAL_CARDINALITY_OR_COVERAGE')
    if any(rows[i]['jdTdb'] - rows[i - 1]['jdTdb'] != 1 for i in range(1, len(rows))):
        raise ValueError('SCI_ORIGINAL_DAILY_GRID')
    odd = rows[1::2]
    if len(odd) != 36525 or len(overlaps) != 4:
        raise ValueError('SCI_ORIGINAL_HELDOUT_OR_OVERLAP_CARDINALITY')
    validation = {'mode': 'all-original-untrained-odd-days', 'oddCount': len(odd), 'rawRows': raw_rows, 'uniqueRows': len(rows), 'firstOddJd': odd[0]['jdTdb'], 'lastOddJd': odd[-1]['jdTdb'], 'overlapAudit': overlaps, 'representationPositionBudgetKm': 10.0, 'representationVelocityBudgetKmS': 0.001, 'errorBasis': 'compact representation-vs-Horizons residual, not observational accuracy'}
    # Keep only three original odd-day witnesses in the JSON. The verifier
    # re-parses the pinned gzip corpus and evaluates all 36525 odd days.
    witnesses = [odd[i] for i in [0, len(odd) // 2, len(odd) - 1]]
    return archives, validation, witnesses


def main():
    parser = argparse.ArgumentParser(description='Generate independent original CSPICE time/vector references plus a pinned all-odd Horizons contract.')
    parser.add_argument('--bsp', required=True)
    parser.add_argument('--lsk', required=True)
    parser.add_argument('--halley-sources', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    for name, expected in SOURCE_PINS.items():
        path = Path(getattr(args, name))
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError(f'SCI_SOURCE_HASH {name}')
        spice.furnsh(str(path))
    try:
        now = dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        dates = [now, '1900-01-01T00:00:00.000Z', '2000-01-01T12:00:00.000Z', '2016-12-31T23:59:59.999Z', '2017-01-01T00:00:00.000Z', '2026-12-24T03:17:19.000Z', '2027-07-01T00:00:00.000Z', '2099-12-31T12:00:00.000Z']
        dates += [(dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(days=i)).isoformat(timespec='milliseconds').replace('+00:00', 'Z') for i in range(731)]
        targets = {'mercury': (199, 10), 'venus': (299, 10), 'earth': (399, 10), 'mars': (4, 10), 'jupiter': (5, 10), 'saturn': (6, 10), 'uranus': (7, 10), 'neptune': (8, 10), 'moon': (301, 399)}
        references = []
        for index, utc in enumerate(dates):
            et = spice.str2et(utc)
            row = {'utc': utc, 'utcMs': dt.datetime.fromisoformat(utc.replace('Z', '+00:00')).timestamp() * 1000, 'jdTdb': 2451545 + et / 86400}
            if index < 8 or index % 61 == 0:
                row['vectors'] = {name: (spice.spkpos(str(target), et, 'ECLIPJ2000', 'NONE', str(center))[0] / 149597870.7).tolist() for name, (target, center) in targets.items()}
            references.append(row)
        archives, validation, witnesses = read_original_halley(args.halley_sources)
        result = {'generatedUtc': now, 'reference': 'spiceypy 8.2.0 / CSPICE N0067; NONE ECLIPJ2000; numerical consistency, not observational accuracy', 'sources': SOURCE_PINS, 'halleyArchives': archives, 'timeAndVectors': references, 'halleyValidation': validation, 'halley': witnesses}
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({'generatedUtc': now, 'timeRows': len(references), 'vectorEpochs': sum('vectors' in r for r in references), 'halleyHeldoutRows': validation['oddCount'], 'rawOriginalRows': validation['rawRows'], 'output': str(output)}))
    finally:
        spice.kclear()


if __name__ == '__main__':
    main()
