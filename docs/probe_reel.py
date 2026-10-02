"""Probe: can the logged-in Shorts sequence API give an endless recommendation feed?

Step 1: home page -> Shorts shelf seeds (reelWatchEndpoint).
Step 2: reel/reel_item_watch on one seed -> sequence continuation.
Step 3: reel/reel_watch_sequence, a few batches.
Raw responses go to $TMPDIR/cc-shorts-probe/ for inspection.

Run with the Python of the pipx-installed yt-dlp:
    ~/.local/pipx/venvs/yt-dlp/bin/python docs/probe_reel.py
Needs YouTube logged in on Chrome (cookies are read via yt-dlp).
"""

import json
import os
import sys
import tempfile

import yt_dlp

# Raw responses carry account data: keep them out of the repo.
OUT = os.path.join(tempfile.gettempdir(), 'cc-shorts-probe')
os.makedirs(OUT, exist_ok=True)


def dump(name, obj):
    with open(os.path.join(OUT, name + '.json'), 'w') as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)


def find_all(obj, key):
    """Yield every value stored under `key` anywhere in a JSON tree."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == key:
                yield v
            yield from find_all(v, key)
    elif isinstance(obj, list):
        for v in obj:
            yield from find_all(v, key)


def find_strings(obj, key):
    return [v for v in find_all(obj, key) if isinstance(v, str)]


ydl = yt_dlp.YoutubeDL({'cookiesfrombrowser': ('chrome',), 'quiet': True, 'no_warnings': True})
ie = ydl.get_info_extractor('YoutubeTab')

# Step 1
page = ie._download_webpage('https://www.youtube.com/', 'home', note=False)
ytcfg = ie.extract_ytcfg('home', page)
initial = ie.extract_yt_initial_data('home', page)
print('logged in:', ytcfg.get('LOGGED_IN'))
seeds = [ep for ep in find_all(initial, 'reelWatchEndpoint') if isinstance(ep, dict) and ep.get('videoId')]
uniq = {}
for ep in seeds:
    uniq.setdefault(ep['videoId'], ep)
seeds = list(uniq.values())
print('seed shorts on home:', len(seeds))
if not seeds:
    sys.exit('no seeds')
print('seed endpoint keys:', sorted(seeds[0].keys()))
dump('seed_endpoint', seeds[0])

context = ytcfg.get('INNERTUBE_CONTEXT')
headers = ie.generate_api_headers(ytcfg=ytcfg)


def call(ep, body, name):
    try:
        res = ie._call_api(ep, body, name, context=context, headers=headers, note=False)
    except Exception as err:  # noqa: BLE001
        print(f'{ep}: FAILED {err}')
        return None
    dump(name, res)
    return res


# Step 2
seed = seeds[0]
item_body = {
    'playerRequest': {
        'videoId': seed['videoId'],
        **({'params': seed['playerParams']} if seed.get('playerParams') else {}),
    },
    'disablePlayerResponse': True,
}
if seed.get('params'):
    item_body['params'] = seed['params']
item = call('reel/reel_item_watch', item_body, 'item_watch')
if item is None:
    sys.exit(1)
print('reel_item_watch top keys:', sorted(item.keys()))

seq_params = (find_strings(item, 'sequenceContinuation') or [None])[0] or seed.get('sequenceParams')
print('sequence params found:', bool(seq_params))
if not seq_params:
    sys.exit('no sequence params')

# Step 3
seen = {s['videoId'] for s in seeds}
all_ids = []
for batch in range(3):
    res = call('reel/reel_watch_sequence', {'sequenceParams': seq_params}, f'sequence_{batch}')
    if res is None:
        break
    ids = []
    for ep in find_all(res.get('entries', res), 'reelWatchEndpoint'):
        if isinstance(ep, dict) and ep.get('videoId') and ep['videoId'] not in ids:
            ids.append(ep['videoId'])
    new = [i for i in ids if i not in seen and i not in all_ids]
    all_ids += new
    print(f'batch {batch}: {len(ids)} ids, {len(new)} new; top keys {sorted(res.keys())}')
    nxt = find_strings(res.get('continuationEndpoint', {}), 'token') or find_strings(res, 'sequenceContinuation')
    if not nxt:
        print('  no continuation token')
        break
    seq_params = nxt[0]

json.dump({'seeds': [s['videoId'] for s in seeds], 'sequence': all_ids}, open(os.path.join(OUT, 'ids.json'), 'w'))
print('total new ids from sequence:', len(all_ids))
